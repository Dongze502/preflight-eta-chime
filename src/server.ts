/**
 * HTTP surface shared by the browser half: settings, the manual preflight, the
 * ring tone assets, and the server-sent event stream that carries live ETA and
 * completion notices.
 *
 * The endpoints are loopback-only because they can spend a model call and
 * rewrite the settings file. Handlers never throw: every failure becomes a
 * JSON body with a status the browser half can show.
 * @module preflight-eta-chime/server
 */
import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Session } from '@deepseek-ai/dsh-session'
import { bucketKey, clampRatio, sourceBucket, type CalibrationStore, type CalibrationView } from './calibration.js'
import { fuseEta, type EtaTracker, type EtaView } from './eta.js'
import { buildSignals, buildTranscript, runPreflight, type PreflightResult, type SubagentRuntimeLike } from './preflight.js'
import type { SettingsStore } from './settings.js'

/** Route paths owned by the plugin. */
export const ROUTES = {
  estimate: '/api/preflight/estimate',
  settings: '/api/preflight-chime/settings',
  events: '/api/preflight-chime/events',
  ding: '/api/preflight-chime/ringtone/ding.wav',
  resolve: '/api/preflight-chime/ringtone/resolve',
} as const

/** Largest JSON body accepted from the browser half. */
const MAX_BODY_BYTES = 64 * 1024
/** Largest custom ring tone accepted, in bytes. */
const MAX_RINGTONE_BYTES = 2 * 1024 * 1024
/** Interval between ETA snapshots on an open event stream. */
const ETA_TICK_MS = 1_000
/** A repeated preflight of the same request inside this window reuses the answer. */
const CACHE_TTL_MS = 10 * 60_000
/** Upper bound on cached preflights, oldest first. */
const CACHE_MAX = 50

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/** The subset of the agent registry the plugin reads. */
export interface AgentRegistryLike {
  get(id: string): unknown
}

/** The subset of the session store the plugin reads. */
export interface SessionStoreLike {
  get(id: string): Session | undefined
}

/** Runtime services the request handlers need, resolved lazily. */
export interface HostBindings {
  settings: SettingsStore
  eta: EtaTracker
  /** Subagent runtime, or undefined when the profile has none. */
  subagents(): SubagentRuntimeLike | undefined
  /** Live agent registry, or undefined. */
  agents(): AgentRegistryLike | undefined
  /** Durable session store. */
  sessions(): SessionStoreLike
  /** Most recent preflight per session id. */
  preflightFor(sessionId: string): PreflightResult | undefined
  /** Record a preflight result for later ETA folding. */
  rememberPreflight(sessionId: string, result: PreflightResult): void
  /** Measured-turn calibration, or undefined when the home is read-only. */
  calibration(): CalibrationStore | undefined
  /** Installed bundles that already notify on completion. */
  notifiers(): string[]
}

/** A JSON response the transport writes. */
export interface JsonReply {
  status: number
  body: Record<string, unknown>
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0]
  return value
}

function parseAuthority(value: string | undefined): { host: string; port?: number } | null {
  if (value === undefined) return null
  const trimmed = value.trim()
  if (trimmed === '') return null
  try {
    const url = new URL(`http://${trimmed}`)
    if (url.hostname === '') return null
    return url.port === '' ? { host: url.hostname } : { host: url.hostname, port: Number(url.port) }
  } catch {
    return null
  }
}

/**
 * Whether a request came from the local page itself.
 * @param req - the incoming request.
 * @returns true for a loopback Host with no cross-site or cross-origin markers.
 */
export function isTrustedRequest(req: IncomingMessage): boolean {
  const authority = parseAuthority(firstHeader(req.headers.host))
  if (authority === null) return false
  if (!LOOPBACK_HOSTS.has(authority.host.toLowerCase())) return false
  const site = firstHeader(req.headers['sec-fetch-site'])
  if (site === 'cross-site' || site === 'cross-origin') return false
  const origin = firstHeader(req.headers.origin)
  if (origin === undefined) return true
  try {
    const parsed = new URL(origin)
    const port = parsed.port === '' ? undefined : Number(parsed.port)
    return parsed.hostname.toLowerCase() === authority.host.toLowerCase() && port === authority.port
  } catch {
    return false
  }
}

/**
 * Read a bounded JSON body.
 * @param req - the incoming request.
 * @returns the parsed value; an empty body yields `{}`.
 * @throws when the body is too large or is not JSON.
 */
export function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body is too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('request body is not valid JSON'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * Write one JSON reply.
 * @param res - the response to write.
 * @param reply - status and body.
 */
export function sendJson(res: ServerResponse, reply: JsonReply): void {
  const text = JSON.stringify(reply.body)
  res.writeHead(reply.status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': String(Buffer.byteLength(text)),
  })
  res.end(text)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The last user and assistant texts, used for sizes and the cache key. */
function lastTexts(session: Session): { requestText: string; previousText: string } {
  let requestText = ''
  let previousText = ''
  let messages: ReturnType<Session['deriveMessages']> = []
  try {
    messages = session.deriveMessages()
  } catch {
    messages = []
  }
  for (const message of messages) {
    let text = ''
    for (const block of message.content) {
      if (block.type === 'text') text += block.text
    }
    if (text.trim().length === 0) continue
    if (message.role === 'user') requestText = text
    else if (message.role === 'assistant') previousText = text
  }
  return { requestText, previousText }
}

/** Sizes of the messages the estimate is about. */

function roundTenth(value: number): number {
  return Math.round(value * 10) / 10
}

/** Apply a measured-turn correction to a fresh preflight. */
function applyCalibration(result: PreflightResult, calibration: CalibrationView): PreflightResult {
  const factor = calibration.factor
  const p50 = result.minutesP50
  if (!result.ok || factor === null) return result
  if (typeof p50 !== 'number' || !Number.isFinite(p50) || p50 <= 0) return result
  const adjusted50 = roundTenth(Math.max(0.05, p50 * factor))
  const rawP90 = typeof result.minutesP90 === 'number' && Number.isFinite(result.minutesP90) ? result.minutesP90 : p50 * 1.7
  const adjusted90 = roundTenth(Math.max(adjusted50 * 1.2, Math.max(0.05, rawP90 * factor)))
  return {
    ...result,
    minutesP50: adjusted50,
    minutesP90: adjusted90,
    calibration: { bucket: calibration.bucket, factor, samples: calibration.samples },
  }
}

/** The calibration a stored result carries, for the response envelope. */
function calibrationOf(result: PreflightResult): PreflightResult['calibration'] | null {
  return result.calibration ?? null
}

/** Cheap stable digest for the cache key; not security-sensitive. */
function digest(text: string): string {
  let hash = 5381
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash * 33) ^ text.charCodeAt(index)) >>> 0
  }
  return hash.toString(36)
}

/** Cache key: same session, same request text, same language. */
export function cacheKey(sessionId: string, language: string, texts: { requestText: string; previousText: string }): string {
  return `${sessionId}|${language}|${digest(texts.requestText)}|${digest(texts.previousText)}`
}

/** Where the bundled ding lives, resolved from the compiled module. */
function dingPath(): URL {
  return new URL('../assets/ding.wav', import.meta.url)
}

function ringtoneMime(source: string): string | undefined {
  const extension = source.toLowerCase().split('.').pop() ?? ''
  if (extension === 'wav') return 'audio/wav'
  if (extension === 'mp3') return 'audio/mpeg'
  if (extension === 'ogg') return 'audio/ogg'
  if (extension === 'm4a') return 'audio/mp4'
  return undefined
}

/**
 * Resolve a custom ring tone into something an `<audio>` element can play.
 * @param source - `data:` URL, https URL, or absolute local path.
 * @returns a data URL, or null when the source is unusable.
 */
export async function resolveRingtone(source: string): Promise<string | null> {
  const trimmed = source.trim()
  if (trimmed === '') return null
  if (trimmed.startsWith('data:audio/')) return trimmed
  if (/^https:\/\//iu.test(trimmed)) {
    if (trimmed.length > 4_000) return null
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 4_000)
      timer.unref?.()
      const response = await fetch(trimmed, { signal: controller.signal, redirect: 'follow' })
      clearTimeout(timer)
      if (!response.ok) return null
      const mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
      if (mime === undefined || !mime.startsWith('audio/')) return null
      const bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.length === 0 || bytes.length > MAX_RINGTONE_BYTES) return null
      return `data:${mime};base64,${bytes.toString('base64')}`
    } catch {
      return null
    }
  }
  if (!/^(?:[A-Za-z]:[\\/]|\/)/u.test(trimmed)) return null
  const mime = ringtoneMime(trimmed)
  if (mime === undefined) return null
  try {
    const bytes = readFileSync(trimmed)
    if (bytes.length === 0 || bytes.length > MAX_RINGTONE_BYTES) return null
    return `data:${mime};base64,${bytes.toString('base64')}`
  } catch {
    return null
  }
}

/** One connected event-stream client. */
interface Subscriber {
  sessionId: string
  res: ServerResponse
  timer: ReturnType<typeof setInterval>
}

/**
 * Request handlers plus the event-stream fan-out.
 *
 * The stream carries three message kinds: `state` on connect and every second
 * while a turn runs, `completed` when a turn ends, and `settings` when the
 * settings change from another page.
 */
export class PreflightServer {
  private readonly subscribers = new Set<Subscriber>()
  private readonly lastEta = new Map<string, string>()
  private readonly lastCompletion = new Map<string, number>()
  private readonly cache = new Map<string, { at: number; result: PreflightResult; signals: string }>()
  private readonly pending = new Map<string, { predictedP50: number; bucket: string }>()
  /**
   * The number the pill showed when the turn began. Every finished turn stores
   * `actual / shown`, so the plugin keeps learning even when the user never runs
   * a preflight — the manual estimator is not the only source of samples.
   */
  private readonly turnPredictions = new Map<string, { predictedP50: number; bucket: string }>()
  /**
   * Request length per session, memoized for the lifetime of one turn.
   *
   * `requestChars()` derives the model-visible history, which is O(messages), and
   * `etaView()` runs once per second per SSE subscriber. Recomputing it there made
   * a long conversation pay a full history walk every tick for a number that only
   * changes when a turn starts.
   */
  private readonly charsCache = new Map<string, { seq: number; chars: number }>()

  /** @param bindings - lazily resolved runtime services. */
  constructor(private readonly bindings: HostBindings) {}

  /** The current ETA document for a session. */
  etaView(sessionId: string): EtaView {
    const evidence = this.bindings.eta.evidence(sessionId)
    const bands = this.bandFactors(sessionId)
    const view = fuseEta(evidence, this.bindings.preflightFor(sessionId), this.bindings.eta.history(sessionId), bands)
    if (view.state === 'running') return view
    if (this.bindings.eta.hasFinished(sessionId)) return { ...view, state: 'finished' }
    return view
  }

  /**
   * Remember what the pill showed before this turn accumulated any evidence.
   * @param sessionId - the session starting a turn.
   */
  noteTurnStart(sessionId: string): void {
    if (!this.bindings.settings.value.learnFromTurns) {
      this.turnPredictions.delete(sessionId)
      return
    }
    const view = this.etaView(sessionId)
    const p50 = view.minutesP50
    if (typeof p50 !== 'number' || !Number.isFinite(p50) || p50 <= 0) {
      this.turnPredictions.delete(sessionId)
      return
    }
    const requestChars = this.requestChars(sessionId)
    const bucket =
      view.source === 'history' || view.source === 'coarse'
        ? sourceBucket(view.source, requestChars)
        : bucketKey(view.complexity ?? undefined, requestChars)
    this.turnPredictions.set(sessionId, { predictedP50: p50, bucket })
  }

  /** Band corrections for the measured-pace and default fallbacks. */
  private bandFactors(sessionId: string): { history?: number | null; coarse?: number | null } {
    const store = this.bindings.calibration()
    if (store === undefined) return {}
    const chars = this.requestChars(sessionId)
    return {
      history: store.view(sourceBucket('history', chars)).factor,
      coarse: store.view(sourceBucket('coarse', chars)).factor,
    }
  }

  /** Characters in the last user message, which sizes the calibration bucket. */
  private requestChars(sessionId: string): number {
    const session = this.bindings.sessions().get(sessionId)
    if (session === undefined) return 0
    // `seq` grows with every appended event, so it is a cheap change stamp: the
    // history is re-derived only after an append, not on every SSE tick.
    if (this.charsCache.size > 200) this.charsCache.clear()
    const cached = this.charsCache.get(sessionId)
    if (cached !== undefined && cached.seq === session.seq) return cached.chars
    const chars = lastTexts(session).requestText.trim().length
    this.charsCache.set(sessionId, { seq: session.seq, chars })
    return chars
  }

  /**
   * Answer `POST /api/preflight/estimate`.
   * @param body - `{ sessionId }`.
   * @returns the preflight result plus the ETA it just enabled.
   */
  async estimate(body: unknown): Promise<JsonReply> {
    const sessionId = (typeof body === 'object' && body !== null ? (body as Record<string, unknown>).sessionId : undefined)
    if (typeof sessionId !== 'string' || sessionId === '') {
      return { status: 400, body: { ok: false, error: 'sessionId is required' } }
    }
    const settings = this.bindings.settings.value
    if (!settings.preflightEnabled) {
      return { status: 409, body: { ok: false, error: 'preflight is disabled in settings' } }
    }
    const session = this.bindings.sessions().get(sessionId)
    if (session === undefined) return { status: 404, body: { ok: false, error: 'unknown session' } }
    const agents = this.bindings.agents()
    const parent = agents?.get(sessionId)
    if (parent === undefined) {
      const degraded = { ok: false, riskFlags: ['preflight_unavailable'], degraded: true }
      return { status: 200, body: { result: degraded, eta: this.etaView(sessionId) } }
    }
    const texts = lastTexts(session)
    const sizes = { requestChars: texts.requestText.trim().length, previousChars: texts.previousText.trim().length }
    const key = cacheKey(sessionId, settings.analysisLanguage, texts)
    const cached = this.cacheGet(key)
    if (cached !== null) {
      this.bindings.rememberPreflight(sessionId, cached.result)
      return {
        status: 200,
        body: {
          result: { ...cached.result, cached: true },
          eta: this.etaView(sessionId),
          signals: cached.signals,
          calibration: calibrationOf(cached.result),
        },
      }
    }
    const signals = buildSignals({ ...sizes, history: this.bindings.eta.history(sessionId) })
    const raw = await runPreflight({
      subagents: this.bindings.subagents(),
      parent,
      transcript: buildTranscript(session),
      signals,
      language: settings.analysisLanguage,
      timeoutMs: settings.preflightTimeoutMs,
    })
    const emptyCalibration: CalibrationView = { bucket: bucketKey(raw.complexity, sizes.requestChars), samples: 0, medianRatio: null, factor: null }
    const calibration = this.bindings.calibration()?.view(emptyCalibration.bucket) ?? emptyCalibration
    const result = applyCalibration(raw, calibration)
    if (result.ok) {
      this.cacheSet(key, { at: Date.now(), result, signals })
      const predicted = raw.minutesP50
      if (typeof predicted === 'number' && Number.isFinite(predicted) && predicted > 0) {
        this.pending.set(sessionId, { predictedP50: predicted, bucket: calibration.bucket })
      }
    }
    this.bindings.rememberPreflight(sessionId, result)
    this.push(sessionId, 'state', this.etaView(sessionId))
    return { status: 200, body: { result, eta: this.etaView(sessionId), signals, calibration } }
  }

  /**
   * Answer `GET`/`POST /api/preflight-chime/settings`.
   * @param body - a partial settings document on POST; undefined on GET.
   * @returns the stored settings.
   */
  settingsReply(body?: unknown): JsonReply {
    if (body !== undefined) {
      this.bindings.settings.update(body)
      const settings = this.bindings.settings.value
      for (const sessionId of new Set([...this.subscribers].map(subscriber => subscriber.sessionId))) {
        this.push(sessionId, 'settings', settings)
      }
    }
    return {
      status: 200,
      body: {
        ok: true,
        settings: this.bindings.settings.value,
        dingUrl: ROUTES.ding,
        notifiers: this.bindings.notifiers(),
        calibration: this.bindings.calibration()?.snapshot() ?? {},
      },
    }
  }

  /**
   * Answer `POST /api/preflight-chime/ringtone/resolve`.
   * @param body - `{ source }`.
   * @returns a playable data URL, or null.
   */
  async resolveReply(body: unknown): Promise<JsonReply> {
    const source = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).source : undefined
    if (typeof source !== 'string') return { status: 400, body: { ok: false, error: 'source is required' } }
    const dataUrl = await resolveRingtone(source)
    return { status: 200, body: { ok: dataUrl !== null, dataUrl } }
  }

  /** Serve the bundled ding. */
  dingReply(): { status: number; bytes?: Buffer } {
    try {
      return { status: 200, bytes: readFileSync(dingPath()) }
    } catch {
      return { status: 404 }
    }
  }

  /**
   * Open a server-sent event stream.
   * @param req - the request, used only for disconnect detection.
   * @param res - the response held open for the stream.
   * @param sessionId - the session whose ETA the page displays.
   */
  openStream(req: IncomingMessage, res: ServerResponse, sessionId: string): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.write(': preflight-eta-chime\n\n')
    const timer = setInterval(() => {
      this.push(sessionId, 'state', this.etaView(sessionId))
    }, ETA_TICK_MS)
    timer.unref?.()
    const subscriber: Subscriber = { sessionId, res, timer }
    this.subscribers.add(subscriber)
    this.push(sessionId, 'state', this.etaView(sessionId))
    const close = (): void => {
      clearInterval(timer)
      this.subscribers.delete(subscriber)
      this.lastEta.delete(sessionId)
      try {
        res.end()
      } catch {
        // Already closed.
      }
    }
    req.on('close', close)
    res.on('close', close)
  }

  /**
   * Publish a turn completion to the pages watching that session.
   * @param sessionId - the session that finished.
   * @param title - the session title shown in the notification.
   * @param completedAt - completion timestamp, used for the 3-second dedupe.
   * @returns whether this completion was published (false when deduped).
   */
  complete(
    sessionId: string,
    title: string,
    options: { completedAt?: number; actualMinutes?: number | null; silentReason?: string | null } = {},
  ): boolean {
    const completedAt = options.completedAt ?? Date.now()
    const previous = this.lastCompletion.get(sessionId)
    if (previous !== undefined && completedAt - previous < 3_000) return false
    this.lastCompletion.set(sessionId, completedAt)
    this.recordCalibration(sessionId, options.actualMinutes ?? null)
    const silentReason = options.silentReason ?? null
    this.push(sessionId, 'completed', {
      ...this.etaView(sessionId),
      title,
      chime: this.bindings.settings.value.chimeEnabled && silentReason === null,
      silentReason,
      completedAt,
    })
    return true
  }

  /**
   * Store `actual / predicted` for the estimate that preceded this turn.
   * @param sessionId - the session that finished.
   * @param actualMinutes - measured turn length, or null when unknown.
   */
  private recordCalibration(sessionId: string, actualMinutes: number | null): void {
    // A preflight made for this turn is the sharper claim: prefer it, and fall
    // back to whatever the pill was showing when the turn started.
    const pending = this.pending.get(sessionId)
    this.pending.delete(sessionId)
    const prediction = pending ?? this.turnPredictions.get(sessionId)
    this.turnPredictions.delete(sessionId)
    if (prediction === undefined) return
    if (actualMinutes === null || !Number.isFinite(actualMinutes) || actualMinutes <= 0) return
    if (!this.bindings.settings.value.learnFromTurns) return
    this.bindings.calibration()?.record(prediction.bucket, clampRatio(actualMinutes / prediction.predictedP50))
  }

  private cacheGet(key: string): { at: number; result: PreflightResult; signals: string } | null {
    const entry = this.cache.get(key)
    if (entry === undefined) return null
    if (Date.now() - entry.at > CACHE_TTL_MS) {
      this.cache.delete(key)
      return null
    }
    return entry
  }

  private cacheSet(key: string, entry: { at: number; result: PreflightResult; signals: string }): void {
    this.cache.set(key, entry)
    while (this.cache.size > CACHE_MAX) {
      const oldest = this.cache.keys().next()
      if (oldest.done) break
      this.cache.delete(oldest.value)
    }
  }

  /** Drop every open stream; used when the plugin unloads. */
  close(): void {
    for (const subscriber of this.subscribers) {
      clearInterval(subscriber.timer)
      try {
        subscriber.res.end()
      } catch {
        // Already closed.
      }
    }
    this.subscribers.clear()
  }

  private push(sessionId: string, event: string, payload: unknown): void {
    const text = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
    if (event === 'state') {
      if (this.lastEta.get(sessionId) === text) return
      this.lastEta.set(sessionId, text)
    }
    for (const subscriber of this.subscribers) {
      if (subscriber.sessionId !== sessionId) continue
      try {
        subscriber.res.write(text)
      } catch {
        // A broken pipe is cleaned up by its own close handler.
      }
    }
  }
}

export { messageOf }

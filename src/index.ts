/**
 * preflight-eta-chime — three independently switchable modules for DeepSeek Harness:
 *
 * 1. a manual, read-only subagent preflight (`POST /api/preflight/estimate`),
 * 2. a live ETA pill fed by `session/event` and the preflight prior,
 * 3. a completion chime plus system notification.
 *
 * Every module is optional at runtime. The plugin never throws into the
 * conversation loop: a missing subagent runtime only disables the preflight,
 * and a failed activation or a broken settings file only produces a degraded
 * result.
 * @module preflight-eta-chime
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { CalibrationStore } from './calibration.js'
import { EtaTracker } from './eta.js'
import { detectNotifierBundles } from './notifiers.js'
import type { PreflightResult, SubagentRuntimeLike } from './preflight.js'
import {
  PreflightServer,
  ROUTES,
  isTrustedRequest,
  readJsonBody,
  sendJson,
  type AgentRegistryLike,
  type HostBindings,
  type SessionStoreLike,
} from './server.js'
import { SettingsStore } from './settings.js'

/** The profile row id and package name. */
export const name = 'preflight-eta-chime'

/**
 * Required services.
 *
 * `subagents` is deliberately absent: Cordis has no optional-dependency form,
 * so declaring it would defer the whole plugin on a profile without a subagent
 * runtime and take the ETA and chime modules down with the preflight. The
 * preflight instead watches the service through `ctx.inject` below.
 */
export const inject = ['sessions', 'llm', 'tools']

/** The subset of the web-server service this plugin registers routes on. */
interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: unknown, res: unknown) => void | Promise<void>
  }): () => void
}

/** The subset of the connection service used to authorize requests. */
interface ConnectionLike {
  admit(request: unknown): { rejection: 401 | 403 } | { peer: unknown }
}

/** The label a completion notice shows for one session. */
function sessionTitle(session: Session): string {
  const cwd = session.header.cwd
  if (typeof cwd === 'string' && cwd.trim() !== '') {
    const folder = cwd.split(/[\\/]/u).filter(part => part !== '').pop()
    if (folder !== undefined) return folder
  }
  return String(session.id)
}

/**
 * Register the plugin.
 * @param ctx - the plugin context.
 * @param config - the profile row's config, used as first-run defaults.
 */
export function apply(ctx: Context, config?: unknown): void {
  const settings = new SettingsStore()
  if (!settings.exists && config !== undefined) settings.update(config)
  const tracker = new EtaTracker()
  const preflights = new Map<string, PreflightResult>()
  let calibration: CalibrationStore | undefined
  try {
    calibration = new CalibrationStore()
  } catch {
    calibration = undefined
  }
  const notifiers = detectNotifierBundles()
  let subagents: SubagentRuntimeLike | undefined

  // The subagent runtime is optional: when it appears the preflight lights up,
  // when it goes away only the preflight degrades.
  ctx.inject(['subagents'], subCtx => {
    subagents = (subCtx as unknown as { subagents?: SubagentRuntimeLike }).subagents
  })

  const bindings: HostBindings = {
    settings,
    eta: tracker,
    subagents: () => subagents,
    agents: () => ctx.get('agents') as AgentRegistryLike | undefined,
    sessions: () => ctx.sessions as unknown as SessionStoreLike,
    preflightFor: sessionId => preflights.get(sessionId),
    rememberPreflight: (sessionId, result) => {
      preflights.set(sessionId, result)
      if (preflights.size > 200) {
        const oldest = preflights.keys().next()
        if (!oldest.done) preflights.delete(oldest.value)
      }
    },
    calibration: () => calibration,
    notifiers: () => notifiers,
  }
  const server = new PreflightServer(bindings)
  ctx.effect(() => () => server.close())

  ctx.on('session/event', (session: Session, event) => {
    // Preflight children run their own turns; they must not feed the user's ETA
    // or ring the completion chime.
    if (session.header.origin === 'subagent') return
    const sessionId = session.id as string
    // The tracker forgets the turn at `turn/end`, so read its clock first.
    const finished = event.type === 'turn/end' ? tracker.evidence(sessionId) : null
    // Whatever the pill showed just before the turn is the number this turn will
    // be measured against, so self-calibration does not depend on a preflight.
    if (event.type === 'turn/start') server.noteTurnStart(sessionId)
    tracker.observe(sessionId, event.type)
    if (event.type === 'turn/end' && event.data.reason.kind === 'completed') {
      const quiet = settings.value.chimeRespectNotifiers && notifiers.length > 0
      server.complete(sessionId, sessionTitle(session), {
        actualMinutes: finished === null ? null : finished.elapsedMs / 60_000,
        silentReason: quiet ? `other-notifier:${notifiers[0] ?? 'unknown'}` : null,
      })
    }
  })

  ctx.inject(['webServer'], webCtx => {
    const webServer = (webCtx as unknown as { webServer?: WebServerLike }).webServer
    if (webServer === undefined) return
    const connection = ctx.get('connection') as ConnectionLike | undefined
    const routes: Array<{ path: string; handler: (req: unknown, res: unknown) => void | Promise<void> }> = [
      {
        path: ROUTES.estimate,
        handler: async (req, res) => {
          await handleJson(req, res, connection, async body => server.estimate(body))
        },
      },
      {
        path: ROUTES.settings,
        handler: async (req, res) => {
          const method = (req as { method?: string }).method
          if (method === 'GET' || method === 'HEAD') {
            await handleJson(req, res, connection, async () => server.settingsReply())
            return
          }
          await handleJson(req, res, connection, async body => server.settingsReply(body))
        },
      },
      {
        path: ROUTES.resolve,
        handler: async (req, res) => {
          await handleJson(req, res, connection, async body => server.resolveReply(body))
        },
      },
      {
        path: ROUTES.ding,
        handler: (req, res) => {
          if (!authorize(req, res, connection)) return
          const response = res as {
            writeHead(status: number, headers?: Record<string, string>): void
            end(body?: unknown): void
          }
          const reply = server.dingReply()
          if (reply.bytes === undefined) {
            response.writeHead(404)
            response.end()
            return
          }
          response.writeHead(200, {
            'Content-Type': 'audio/wav',
            'Cache-Control': 'no-store',
            'Content-Length': String(reply.bytes.length),
          })
          response.end(reply.bytes)
        },
      },
      {
        path: ROUTES.events,
        handler: (req, res) => {
          if (!authorize(req, res, connection)) return
          const url = new URL(String((req as { url?: string }).url ?? '/'), 'http://127.0.0.1')
          const sessionId = url.searchParams.get('sessionId') ?? ''
          if (sessionId === '') {
            const response = res as { writeHead(status: number): void; end(body?: string): void }
            response.writeHead(400)
            response.end('sessionId is required')
            return
          }
          server.openStream(
            req as Parameters<PreflightServer['openStream']>[0],
            res as Parameters<PreflightServer['openStream']>[1],
            sessionId,
          )
        },
      },
    ]
    for (const route of routes) {
      webCtx.effect(() => webServer.register({ kind: 'exact', path: route.path, handler: route.handler }), `preflight-eta-chime: ${route.path}`)
    }
  })
}

/**
 * Apply the same fence the Host uses for its own `/api` channel: a loopback
 * `Host` with no cross-site marker, then the signed browser cookie when the
 * profile runs a Connection service.
 * @param req - the incoming request.
 * @param res - the outgoing response.
 * @param connection - the connection service, when the profile has one.
 * @returns true when the handler may run.
 */
function authorize(req: unknown, res: unknown, connection: ConnectionLike | undefined): boolean {
  const response = res as { writeHead(status: number, headers?: Record<string, string>): void; end(body?: string): void }
  if (!isTrustedRequest(req as Parameters<typeof isTrustedRequest>[0])) {
    response.writeHead(403)
    response.end('forbidden')
    return false
  }
  if (connection === undefined) return true
  const admission = connection.admit(req)
  if ('rejection' in admission) {
    response.writeHead(admission.rejection)
    response.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
    return false
  }
  return true
}

/**
 * Authorize, read the body, and write one JSON reply.
 * @param req - the incoming request.
 * @param res - the outgoing response.
 * @param connection - the connection service, when the profile has one.
 * @param run - produces the reply body.
 */
async function handleJson(
  req: unknown,
  res: unknown,
  connection: ConnectionLike | undefined,
  run: (body: unknown) => Promise<{ status: number; body: Record<string, unknown> }>,
): Promise<void> {
  const response = res as { writeHead(status: number, headers?: Record<string, string>): void; end(body?: string): void }
  const request = req as { method?: string; headers?: Record<string, unknown> }
  if (!authorize(req, res, connection)) return
  const method = request.method ?? 'GET'
  if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
    response.writeHead(405)
    response.end('method not allowed')
    return
  }
  try {
    const body = method === 'POST' ? await readJsonBody(req as Parameters<typeof readJsonBody>[0]) : {}
    const reply = await run(body)
    sendJson(res as Parameters<typeof sendJson>[0], reply)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    sendJson(res as Parameters<typeof sendJson>[0], { status: 400, body: { ok: false, error: message } })
  }
}

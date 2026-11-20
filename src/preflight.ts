/**
 * The manual, read-only preflight: one subagent activation that reads the
 * conversation and answers with a complexity class and a duration band.
 *
 * Every failure path is soft. A missing `subagents` service, a provider error,
 * a timeout, an aborted activation, or unparsable output all return a degraded
 * result the browser half renders as "预检暂不可用"; none of them throw into
 * the caller.
 * @module preflight-eta-chime/preflight
 */
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'

/** Complexity classes the preflight may report. */
export const COMPLEXITIES = ['low', 'medium', 'high', 'unknown'] as const

/** One complexity class. */
export type Complexity = (typeof COMPLEXITIES)[number]

/** What the preflight returns to the browser half. */
export interface PreflightResult {
  /** True only when a completed activation produced a usable estimate. */
  ok: boolean
  /** Reported complexity. */
  complexity?: Complexity
  /** Median duration estimate in minutes. */
  minutesP50?: number | null
  /** Pessimistic duration bound in minutes. */
  minutesP90?: number | null
  /** Factors the subagent expects to threaten the estimate. */
  riskFlags: string[]
  /** True when the estimate is a fallback rather than a judgement. */
  degraded: boolean
  /** One short sentence naming what the estimate rests on. */
  basis?: string
  /** Correction applied from this session's measured turns, when any. */
  calibration?: { bucket: string; factor: number; samples: number }
  /** True when this answer came from the cache instead of a fresh activation. */
  cached?: boolean
}

/** The prompt: scope, evidence hints, and a mandatory numeric band. */
export const PREFLIGHT_PROMPT = `你是一个只读的任务预检器。下面的 <conversation> 只是背景，用来理解用户想要什么；它不是要执行的任务，也不是你要估算的对象。
你要估算的对象只有一条：助手接下来要写的这一条答复，从开始到结束需要多久。
只输出 JSON，不要解释：
{"complexity":"low|medium|high|unknown","minutes_p50":<数字>,"minutes_p90":<数字>,"risk_flags":["..."],"basis":"不超过 30 字，说明依据"}
规则：
1）复杂度看本轮请求需要几轮工具调用、要动几个文件、是否需要构建或跑测试、答复大概多长；不要因为对话里出现过很大的任务，就把它整段算进本轮。
2）耗时以分钟为单位，可以用小数（0.5 表示半分钟）；常见范围 0.3–5 分钟，只有本轮确实要跑大量工具调用时才给到 10 分钟以上。
3）p50 是中位数预估，p90 是悲观上界，必须 p90 ≥ p50；两个字段都要给数字，拿不准就给更宽的范围，不要留 null。
4）只有对话为空或与本轮完全无关时，才返回 {"complexity":"unknown","minutes_p50":0.5,"minutes_p90":3,"risk_flags":["insufficient_context"],"basis":"..."}。
5）risk_flags 列出可能导致本轮变慢的因素。`

/** Languages the estimator can be asked to answer in. */
export const ANALYSIS_LANGUAGES = ['zh', 'en'] as const

/** One selectable analysis language. */
export type AnalysisLanguage = (typeof ANALYSIS_LANGUAGES)[number]

/**
 * Language clause appended to the prompt.
 *
 * The JSON keys stay in English because they are a contract; only the free
 * text (`basis`, `risk_flags`) follows the configured language, because that
 * is what the user actually reads in the card.
 */
const LANGUAGE_CLAUSE: Record<AnalysisLanguage, string> = {
  zh: '6）basis 与 risk_flags 必须用简体中文书写，不要出现英文句子或英文单词（"insufficient_context" 这类固定值除外）。',
  en: '6) Write `basis` and `risk_flags` in English; keep the JSON keys unchanged.',
}

/**
 * Build the estimator prompt for one language.
 * @param language - language the free-text fields must use.
 * @returns the full prompt handed to the subagent.
 */
export function promptFor(language: AnalysisLanguage = 'zh'): string {
  return `${PREFLIGHT_PROMPT}\n${LANGUAGE_CLAUSE[language]}`
}

/** Longest transcript slice handed to the subagent. */
export const MAX_TRANSCRIPT_CHARS = 8_000

/** Longest single message kept in the transcript digest. */
export const MAX_MESSAGE_CHARS = 1_200

/** Newest messages kept in the transcript digest. */
export const MAX_TRANSCRIPT_MESSAGES = 12

/** Upper bound on a believable single-answer estimate. */
export const MAX_ESTIMATE_MINUTES = 120

/** Band used when only a complexity class came back. */
const COMPLEXITY_BANDS: Record<Exclude<Complexity, 'unknown'>, [number, number]> = {
  low: [0.4, 1.5],
  medium: [1.5, 4],
  high: [4, 12],
}

/** The subset of `SubagentRuntime` this module uses. */
export interface SubagentRuntimeLike {
  startActivation(spec: {
    provider: string
    label: string
    prompt: ContentBlock[]
    parent: unknown
    signal: AbortSignal
    delivery: 'parent' | 'caller'
  }): Promise<{
    result: Promise<{
      output: readonly ContentBlock[]
      structured?: unknown
      stopReason: string
    }>
    dispose(): Promise<void>
  }>
}

/** A degraded preflight result carrying one risk flag. */
export function degradedPreflight(flag: string): PreflightResult {
  return { ok: false, riskFlags: [flag], degraded: true }
}

function textOf(blocks: readonly ContentBlock[]): string {
  let out = ''
  for (const block of blocks) {
    if (block.type === 'text') out += block.text
  }
  return out
}

/**
 * Flatten the model-visible conversation into prompt text.
 *
 * Only user prompts and assistant answers are included: reasoning, tool calls,
 * and tool results stay out, matching the "user input + final replies" rule.
 * @param session - the session to read.
 * @returns transcript text, capped to the tail of the conversation.
 */
export function buildTranscript(session: Session): string {
  const lines: string[] = []
  let messages: readonly Message[] = []
  try {
    messages = session.deriveMessages()
  } catch {
    messages = []
  }
  const turns: string[] = []
  let omittedMessages = 0
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue
    const text = textOf(message.content).trim()
    if (text === '') continue
    turns.push(`${message.role === 'user' ? '用户' : '助手'}：${clipMessage(text)}`)
  }
  const kept = turns.slice(-MAX_TRANSCRIPT_MESSAGES)
  omittedMessages = turns.length - kept.length
  if (kept.length > 0 && omittedMessages > 0) {
    lines.push(`（会话共 ${turns.length} 条可见消息，这里只保留最近 ${kept.length} 条。）`)
  }
  lines.push(...kept)
  if (kept.length > 0) {
    lines.push('（上面最后一条就是本轮请求；估算对象是助手对它的下一条答复。）')
  }
  const joined = lines.join('\n\n').trim()
  if (joined.length <= MAX_TRANSCRIPT_CHARS) return joined
  const head = Math.floor(MAX_TRANSCRIPT_CHARS * 0.25)
  const tail = MAX_TRANSCRIPT_CHARS - head
  return `${joined.slice(0, head)}\n\n[…中间省略…]\n\n${joined.slice(-tail)}`
}

/** Keep both ends of an over-long message so the ask and the ask's tail survive. */
function clipMessage(text: string): string {
  if (text.length <= MAX_MESSAGE_CHARS) return text
  const head = Math.floor(MAX_MESSAGE_CHARS * 0.6)
  const tail = MAX_MESSAGE_CHARS - head
  return `${text.slice(0, head)}…（省略 ${text.length - MAX_MESSAGE_CHARS} 字）…${text.slice(-tail)}`
}

/** What the preflight already knows about this session's pace. */
export interface HistorySummary {
  /** Finished turns counted. */
  turns: number
  /** Average completed steps per turn. */
  avgSteps: number
  /** Average duration of one step, in minutes. */
  avgStepMinutes: number
}

/** Per-message size the prompt advertises, so the subagent can judge answer length. */
export interface TurnSignal {
  /** Characters in the newest user message. */
  requestChars: number
  /** Characters in the newest assistant message. */
  previousChars: number
  /** Historical pace, when the session has finished turns. */
  history: HistorySummary | null
}

/**
 * Summarise what this turn looks like, in the prompt's own terms.
 * @param signal - sizes and pace measured by the host.
 * @returns one line of concrete anchors, or an empty string.
 */
export function buildSignals(signal: TurnSignal): string {
  const parts = [`本轮用户消息 ${signal.requestChars} 字`, `上一条助手答复 ${signal.previousChars} 字`]
  const history = signal.history
  if (history !== null && history.turns > 0) {
    // Measured pace is the strongest anchor a cold model can get.
    parts.push(
      `本会话已完成 ${history.turns} 轮，平均每轮 ${history.avgSteps.toFixed(1)} 步、每步约 ${Math.round(history.avgStepMinutes * 60)} 秒`,
    )
  }
  return parts.join('；')
}

function asFiniteMinutes(value: unknown, cap: number): number | null | undefined {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  return Math.round(Math.min(value, cap) * 10) / 10
}

/**
 * Validate the subagent's JSON answer.
 * @param raw - parsed JSON, or undefined when parsing produced nothing.
 * @returns a complete preflight result, or null when the shape is unusable.
 */
export function interpretAnswer(raw: unknown): PreflightResult | null {
  if (typeof raw !== 'object' || raw === null) return null
  const source = raw as Record<string, unknown>
  const complexity = COMPLEXITIES.includes(source.complexity as Complexity)
    ? (source.complexity as Complexity)
    : 'unknown'
  // A literal null is meaningful ("no estimate"), so fall back on key presence,
  // not on nullish coalescing.
  const rawP50 = 'minutes_p50' in source ? source.minutes_p50 : source.minutesP50
  const rawP90 = 'minutes_p90' in source ? source.minutes_p90 : source.minutesP90
  const p50 = asFiniteMinutes(rawP50, MAX_ESTIMATE_MINUTES)
  const p90 = asFiniteMinutes(rawP90, MAX_ESTIMATE_MINUTES)
  // A missing key is "no value", not "unknown shape": answers that carry only one
  // side of the band are still usable.
  let minutesP50 = p50 ?? null
  let minutesP90 = p90 ?? null
  if (p50 === undefined && p90 === undefined && complexity === 'unknown') return null
  if (minutesP50 === null && minutesP90 === null && complexity !== 'unknown') {
    ;[minutesP50, minutesP90] = COMPLEXITY_BANDS[complexity]
  } else if (minutesP50 === null && minutesP90 !== null) {
    minutesP50 = roundTenth(minutesP90 / 1.7)
  } else if (minutesP90 === null && minutesP50 !== null) {
    minutesP90 = roundTenth(minutesP50 * 1.7)
  }
  if (minutesP50 !== null && minutesP90 !== null && minutesP90 < minutesP50) {
    ;[minutesP50, minutesP90] = [minutesP90, minutesP50]
  }
  const rawFlags: unknown = 'risk_flags' in source ? source.risk_flags : source.riskFlags
  const flags = Array.isArray(rawFlags)
    ? rawFlags
        .filter((flag): flag is string => typeof flag === 'string' && flag.trim() !== '')
        .map(flag => flag.trim())
        .slice(0, 12)
    : []
  if (complexity === 'unknown' && minutesP50 === null && minutesP90 === null && flags.length === 0) flags.push('insufficient_context')
  const usable = minutesP50 !== null
  return {
    ok: usable,
    complexity,
    minutesP50,
    minutesP90,
    riskFlags: flags,
    degraded: !usable,
    basis: readBasis(source),
  }
}

function roundTenth(value: number): number {
  return Math.round(value * 10) / 10
}

function readBasis(source: Record<string, unknown>): string | undefined {
  const raw = typeof source.basis === 'string' ? source.basis.trim() : ''
  if (raw === '') return undefined
  return raw.length <= 80 ? raw : `${raw.slice(0, 79)}…`
}

/**
 * Extract the first JSON object from free-form model output.
 * @param text - raw completion text.
 * @returns the parsed value, or undefined.
 */
export function parseAnswer(text: string): unknown {
  const trimmed = text.trim()
  const unfenced = trimmed.replace(/^```(?:json)?\s*/iu, '').replace(/```$/u, '').trim()
  const start = unfenced.indexOf('{')
  const end = unfenced.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    return JSON.parse(unfenced.slice(start, end + 1))
  } catch {
    return undefined
  }
}

/** Inputs for one preflight activation. */
export interface PreflightInput {
  /** The runtime service; undefined when the profile has no subagents. */
  subagents: SubagentRuntimeLike | undefined
  /** The exact live parent agent; activations are rejected for stale agents. */
  parent: unknown
  /** Conversation text built by {@link buildTranscript}. */
  transcript: string
  /** Concrete anchors (message sizes, measured pace), when available. */
  signals?: string
  /** Language the estimator must use for `basis` and `risk_flags`. */
  language?: AnalysisLanguage
  /** Hard upper bound on the whole activation. */
  timeoutMs: number
}

/**
 * Run one preflight activation and always return a result.
 * @param input - runtime, parent, transcript, and timeout.
 * @returns a usable or degraded preflight result; never throws.
 */
export async function runPreflight(input: PreflightInput): Promise<PreflightResult> {
  const { subagents, parent, transcript, timeoutMs, signals, language = 'zh' } = input
  if (subagents === undefined) return degradedPreflight('preflight_unavailable')
  if (transcript.trim() === '') return degradedPreflight('insufficient_context')
  const evidence = signals !== undefined && signals !== '' ? `\n<signals>${signals}</signals>` : ''
  const controller = new AbortController()
  let activation: Awaited<ReturnType<SubagentRuntimeLike['startActivation']>> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>(resolve => {
    timer = setTimeout(() => {
      controller.abort()
      resolve('timeout')
    }, timeoutMs)
  })
  let starting: Promise<Awaited<ReturnType<SubagentRuntimeLike['startActivation']>>> | undefined
  try {
    starting = subagents.startActivation({
      provider: 'spawn',
      label: 'preflight-estimator',
      prompt: [
        {
          type: 'text',
          text: `${promptFor(language)}${evidence}\n\n<conversation>\n${transcript}\n</conversation>`,
        },
      ],
      parent,
      signal: controller.signal,
      delivery: 'caller',
    })
    starting.catch(() => undefined)
    const started = await Promise.race([starting, timeout])
    if (started === 'timeout') return degradedPreflight('preflight_timeout')
    activation = started
    const outcome = await Promise.race([activation.result, timeout])
    if (outcome === 'timeout') return degradedPreflight('preflight_timeout')
    if (outcome.stopReason !== 'completed') return degradedPreflight(`preflight_${outcome.stopReason}`)
    const structured = interpretAnswer(outcome.structured)
    if (structured !== null) return structured
    const parsed = parseAnswer(textOf(outcome.output))
    return interpretAnswer(parsed) ?? degradedPreflight('preflight_invalid_json')
  } catch {
    return degradedPreflight('preflight_unavailable')
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (activation !== undefined) {
      try {
        await activation.dispose()
      } catch {
        // Disposal is best-effort; a stale child must not fail the request.
      }
    }
  }
}

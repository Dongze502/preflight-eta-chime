/**
 * Live ETA folding: preflight prior + deterministic execution evidence.
 *
 * The prior comes from the read-only subagent (`./preflight.ts`); the evidence
 * is what actually happened in the turn — elapsed time and completed steps.
 * Evidence wins as it accumulates, so a bad prior cannot keep the estimate
 * wrong once real progress exists.
 * @module preflight-eta-chime/eta
 */
import type { PreflightResult } from './preflight.js'

/** Steps a complexity class is expected to need; the denominator of the pace estimate. */
const EXPECTED_STEPS: Record<string, number> = { low: 2, medium: 4, high: 6, unknown: 3 }

/** Evidence count at which the prior weight settles on its floor. */
const EVIDENCE_SATURATION = 5
/** Smallest weight the prior keeps while a turn runs. */
const MIN_PRIOR_WEIGHT = 0.2

/** Minutes the deterministic estimate reports before any step has completed. */
const NO_EVIDENCE = null

/** Band shown before the first turn of a session, when nothing else exists. */
const COARSE_BAND: readonly [number, number] = [0.5, 2.5]

/** Which input the displayed band rests on. */
export type EtaSource = 'preflight' | 'evidence' | 'history' | 'coarse'

/** Measured pace from finished turns, used when no preflight exists. */
export interface TurnHistory {
  /** Finished turns counted. */
  turns: number
  /** Average completed steps per turn. */
  avgSteps: number
  /** Average duration of one step, in minutes. */
  avgStepMinutes: number
}

/** What one live turn has shown so far. */
export interface TurnEvidence {
  /** Wall-clock milliseconds since `turn/start`. */
  elapsedMs: number
  /** Steps that have closed in this turn. */
  stepsDone: number
  /** Sum of completed step durations, in milliseconds. */
  stepMs: number
}

/** The ETA document the browser half renders. */
export interface EtaView {
  /** `idle` before a turn, `running` while one executes, `finished` between turns. */
  state: 'idle' | 'running' | 'finished'
  /** Median estimate in minutes, or null when there is nothing to go on. */
  minutesP50: number | null
  /** Pessimistic bound in minutes, or null. */
  minutesP90: number | null
  /** Milliseconds already spent in the current turn. */
  elapsedMs: number
  /** Completed steps in the current turn. */
  stepsDone: number
  /** Complexity reported by the preflight, when one ran. */
  complexity: PreflightResult['complexity'] | null
  /** Whether the preflight degraded (missing, timed out, malformed). */
  preflightDegraded: boolean
  /** Weight the prior currently carries, for the details popover. */
  priorWeight: number
  /** What the displayed numbers rest on; null when there are no numbers. */
  source: EtaSource | null
  /** The preflight's own one-line explanation, when it gave one. */
  basis: string | null
}

/** The empty ETA document. */
export const IDLE_ETA: EtaView = Object.freeze({
  state: 'idle',
  minutesP50: NO_EVIDENCE,
  minutesP90: NO_EVIDENCE,
  elapsedMs: 0,
  stepsDone: 0,
  complexity: null,
  preflightDegraded: false,
  priorWeight: 0,
  source: null,
  basis: null,
})

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Prior weight for a given amount of evidence.
 * @param evidence - completed steps in the turn.
 * @returns the preflight weight, in `[0.2, 1]`.
 */
export function priorWeight(evidence: number): number {
  return clamp(1 - evidence / EVIDENCE_SATURATION, MIN_PRIOR_WEIGHT, 1)
}

/**
 * Deterministic remaining-time estimate from observed pace.
 * @param evidence - elapsed time and completed steps.
 * @param complexity - a complexity class, when one is known.
 * @returns minutes remaining, or null without evidence.
 */
export function deterministicMinutes(evidence: TurnEvidence, complexity: string | undefined): number | null {
  if (evidence.stepsDone <= 0 || evidence.elapsedMs <= 0) return null
  const expected = Number(EXPECTED_STEPS[complexity ?? 'unknown'] ?? 3)
  const remaining = Math.max(expected - evidence.stepsDone, 1)
  const averageStepMs = evidence.stepMs > 0 ? evidence.stepMs / evidence.stepsDone : evidence.elapsedMs / evidence.stepsDone
  return Math.max(0.2, (averageStepMs * remaining) / 60_000)
}

function usablePrior(preflight: PreflightResult | undefined): number | null {
  if (preflight === undefined || !preflight.ok || preflight.degraded) return null
  const p50 = preflight.minutesP50
  return typeof p50 === 'number' && Number.isFinite(p50) ? p50 : null
}

/**
 * A band from measured pace alone.
 * @param history - finished-turn pace, when the session has one.
 * @param subtractMinutes - time already spent, subtracted from the total.
 * @returns a plausible band, or null without history.
 */
function historyBand(
  history: TurnHistory | null | undefined,
  subtractMinutes: number,
): { p50: number; p90: number } | null {
  if (history === undefined || history === null || history.turns <= 0) return null
  const total = Math.max(0.2, history.avgSteps * history.avgStepMinutes)
  const p50 = Math.max(0.1, total - subtractMinutes)
  return { p50: roundTenth(p50), p90: roundTenth(Math.max(p50 * 1.7, p50 + 0.2)) }
}

function roundTenth(value: number): number {
  return Math.round(value * 10) / 10
}

function coarseBand(subtractMinutes: number): { p50: number; p90: number } {
  const [low, high] = COARSE_BAND
  const p50 = Math.max(0.1, low - subtractMinutes)
  return { p50: roundTenth(p50), p90: roundTenth(Math.max(high - subtractMinutes, p50 + 0.5)) }
}

/**
 * Fuse the preflight prior with the deterministic evidence.
 *
 * The fallback chain is preflight → measured pace → coarse band, so the pill
 * only shows `—` when the feature is switched off. Everything below the
 * preflight is labelled through {@link EtaView.source} so the popover can say
 * where a number came from.
 * @param evidence - what the current turn has shown.
 * @param preflight - the most recent preflight result for this session.
 * @param history - pace measured from the session's finished turns.
 * @returns the ETA document.
 */
/** Band corrections learned from completed turns without a preflight. */
export interface BandFactors {
  /** Multiplier for the measured-pace band. */
  history?: number | null
  /** Multiplier for the default band used when nothing is known. */
  coarse?: number | null
}

function scaleBand(band: { p50: number; p90: number } | null, factor: number | null | undefined): { p50: number; p90: number } | null {
  if (band === null || typeof factor !== 'number' || !Number.isFinite(factor) || factor <= 0) return band
  const p50 = roundTenth(Math.max(0.05, band.p50 * factor))
  return { p50, p90: roundTenth(Math.max(p50 * 1.2, band.p90 * factor)) }
}

export function fuseEta(
  evidence: TurnEvidence | null,
  preflight: PreflightResult | undefined,
  history?: TurnHistory | null,
  bands?: BandFactors,
): EtaView {
  const prior = usablePrior(preflight)
  if (evidence === null) {
    const plannedP90 =
      typeof preflight?.minutesP90 === 'number' && Number.isFinite(preflight.minutesP90) ? preflight.minutesP90 : null
    const measured = scaleBand(historyBand(history, 0), bands?.history)
    const fallback = prior === null ? (measured ?? scaleBand(coarseBand(0), bands?.coarse)) : null
    const p50 = prior ?? fallback?.p50 ?? null
    const p90 = p50 === null ? null : Math.max(p50, plannedP90 ?? fallback?.p90 ?? p50 * 1.8)
    return {
      ...IDLE_ETA,
      // Keep the preflight numbers verbatim: rounding them here made the pill say
      // "1–2 分钟" while the card said "1 分钟以内" for the same estimate.
      minutesP50: p50,
      minutesP90: p90,
      complexity: preflight?.complexity ?? null,
      preflightDegraded: preflight !== undefined && preflight.degraded,
      priorWeight: prior === null ? 0 : 1,
      source: prior !== null ? 'preflight' : fallback === null ? 'coarse' : measured !== null ? 'history' : 'coarse',
      basis: preflight?.basis ?? null,
    }
  }
  const deterministic = deterministicMinutes(evidence, preflight?.complexity)
  const weight = prior === null ? 0 : priorWeight(evidence.stepsDone)
  // `prior` is this turn's total length; the pill counts down, so subtract what
  // the turn has already spent before blending it with the observed pace.
  const elapsedMinutes = evidence.elapsedMs / 60_000
  const priorRemaining = prior === null ? null : Math.max(prior - elapsedMinutes, 0.05)
  let p50 =
    priorRemaining === null
      ? deterministic
      : deterministic === null
        ? priorRemaining
        : weight * priorRemaining + (1 - weight) * deterministic
  let source: EtaSource | null = prior !== null ? 'preflight' : deterministic !== null ? 'evidence' : null
  if (p50 === null) {
    // No prior and no completed step yet: fall back to measured pace, then to a
    // deliberately wide default, so the pill is never blank.
    const measured = scaleBand(historyBand(history, elapsedMinutes), bands?.history)
    if (measured !== null) {
      p50 = measured.p50
      source = 'history'
    } else {
      p50 = scaleBand(coarseBand(elapsedMinutes), bands?.coarse)?.p50 ?? coarseBand(elapsedMinutes).p50
      source = 'coarse'
    }
  }
  const p90Prior =
    typeof preflight?.minutesP90 === 'number' && Number.isFinite(preflight.minutesP90)
      ? Math.max(preflight.minutesP90 - elapsedMinutes, 0.05)
      : null
  const p90 = Math.max(p50, p90Prior ?? p50 * 1.8)
  return {
    state: 'running',
    minutesP50: roundTenth(p50),
    minutesP90: roundTenth(p90),
    elapsedMs: Math.max(0, Math.round(evidence.elapsedMs)),
    stepsDone: evidence.stepsDone,
    complexity: preflight?.complexity ?? null,
    preflightDegraded: preflight !== undefined && preflight.degraded,
    priorWeight: Math.round(weight * 100) / 100,
    source,
    basis: preflight?.basis ?? null,
  }
}

/** One observed turn, folded from `session/event`. */
interface TurnState {
  startedAt: number
  stepsDone: number
  stepMs: number
  stepStartedAt: number | null
}

/**
 * Fold `turn/start`, `step/start`, `step/end` and `turn/end` into live
 * evidence. One instance serves every session; the host calls it only for
 * sessions that are not subagent children.
 */
export class EtaTracker {
  private readonly turns = new Map<string, TurnState>()
  private readonly finished = new Set<string>()
  private readonly pace = new Map<string, { turns: number; steps: number; stepMs: number }>()

  /**
   * Apply one session event.
   * @param sessionId - the session that emitted it.
   * @param type - the session event type.
   */
  observe(sessionId: string, type: string): void {
    const now = Date.now()
    const turn = this.turns.get(sessionId)
    switch (type) {
      case 'turn/start':
        this.turns.set(sessionId, { startedAt: now, stepsDone: 0, stepMs: 0, stepStartedAt: null })
        this.finished.delete(sessionId)
        return
      case 'step/start':
        if (turn !== undefined) {
          turn.stepStartedAt = now
          this.turns.set(sessionId, turn)
        }
        return
      case 'step/end':
        if (turn !== undefined) {
          if (turn.stepStartedAt !== null) turn.stepMs += now - turn.stepStartedAt
          turn.stepStartedAt = null
          turn.stepsDone += 1
          this.turns.set(sessionId, turn)
        }
        return
      case 'turn/end':
        if (turn !== undefined) {
          this.finished.add(sessionId)
          this.recordPace(sessionId, turn)
          this.turns.delete(sessionId)
        }
        return
      default:
    }
  }

  /**
   * Current evidence for a session.
   * @param sessionId - the session to read.
   * @returns live evidence, or null when no turn is running.
   */
  evidence(sessionId: string): TurnEvidence | null {
    const turn = this.turns.get(sessionId)
    if (turn === undefined) return null
    return {
      elapsedMs: Math.max(0, Date.now() - turn.startedAt),
      stepsDone: turn.stepsDone,
      stepMs: turn.stepMs,
    }
  }

  /**
   * Whether the last observed turn finished, for the `finished` pill state.
   * @param sessionId - the session to read.
   */
  hasFinished(sessionId: string): boolean {
    return this.finished.has(sessionId)
  }

  /**
   * Measured pace from the session's finished turns.
   * @param sessionId - the session to read.
   * @returns the rolling average, or null before the first completed step.
   */
  history(sessionId: string): TurnHistory | null {
    const record = this.pace.get(sessionId)
    if (record === undefined || record.turns <= 0 || record.steps <= 0) return null
    return {
      turns: record.turns,
      avgSteps: record.steps / record.turns,
      avgStepMinutes: record.stepMs / record.steps / 60_000,
    }
  }

  /** Fold one finished turn into the rolling pace, keeping the last 20 turns. */
  private recordPace(sessionId: string, turn: TurnState): void {
    if (turn.stepsDone <= 0) return
    // Sub-millisecond steps would divide by zero; clamp instead of dropping the turn.
    const stepMs = Math.max(turn.stepMs, 1)
    const record = this.pace.get(sessionId) ?? { turns: 0, steps: 0, stepMs: 0 }
    record.turns += 1
    record.steps += turn.stepsDone
    record.stepMs += stepMs
    if (record.turns > 20) {
      // Halve the accumulators so the average follows the recent pace.
      record.turns = Math.ceil(record.turns / 2)
      record.steps = Math.ceil(record.steps / 2)
      record.stepMs = Math.ceil(record.stepMs / 2)
    }
    this.pace.set(sessionId, record)
  }
}

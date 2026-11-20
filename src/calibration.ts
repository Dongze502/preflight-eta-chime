/**
 * Calibration of the preflight estimate against measured turns.
 *
 * A semantic preflight can only guess: it never sees how long a tool call
 * really takes. What it can do is remember how wrong it was. Every completed
 * turn stores `actual / predicted` in a bucket keyed by the complexity the
 * estimator claimed and the size of the request, and the median ratio of that
 * bucket is applied to the next estimate of the same shape.
 *
 * Buckets stay small and local: the file lives next to the settings, holds at
 * most {@link MAX_RATIOS_PER_BUCKET} samples per bucket, and a read-only home
 * only costs the correction, never the preflight.
 * @module preflight-eta-chime/calibration
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { settingsDirectory } from './settings.js'

/** Ratios kept per bucket; older samples fall off the front. */
export const MAX_RATIOS_PER_BUCKET = 50
/** Samples needed before a correction is trusted. */
export const MIN_SAMPLES_FOR_FACTOR = 3
/** A correction never shrinks below this, or one bad turn would erase the prior. */
export const MIN_FACTOR = 0.25
/** A correction never grows beyond this, or one interrupted turn would dominate. */
export const MAX_FACTOR = 4
/** Ratios outside this range are measurement accidents, not a signal. */
export const MIN_RATIO = 0.05
export const MAX_RATIO = 20

/** Request size buckets: short replies, ordinary edits, big reads. */
export type SizeBucket = 'short' | 'medium' | 'long'

/** One bucket as the browser half presents it. */
export interface CalibrationView {
  /** `<complexity>|<size>` */
  bucket: string
  /** How many measured turns feed this bucket. */
  samples: number
  /** Median of `actual / predicted`, before the factor clamps. */
  medianRatio: number | null
  /** Multiplier applied to the next estimate, or null while uncalibrated. */
  factor: number | null
}

/** Bucket for the length of the request the estimate is about. */
export function sizeBucket(requestChars: number): SizeBucket {
  if (!Number.isFinite(requestChars) || requestChars < 400) return 'short'
  if (requestChars < 2_000) return 'medium'
  return 'long'
}

/**
 * Bucket key for one estimate.
 * @param complexity - what the estimator claimed, or undefined when unknown.
 * @param requestChars - characters in the user message the estimate is about.
 * @returns a stable key such as `medium|short`.
 */
export function bucketKey(complexity: string | undefined, requestChars: number): string {
  const label = typeof complexity === 'string' && complexity.trim() !== '' ? complexity.trim() : 'unknown'
  return `${label}|${sizeBucket(requestChars)}`
}

/**
 * Bucket for a prediction that came from the measured-pace or default band.
 *
 * Turns without a preflight still teach the plugin something: the pill showed a
 * number, the turn took a while, and the ratio between them corrects the same
 * band next time. These buckets are keyed by the source instead of a complexity,
 * because no estimator made a claim about them.
 * @param source - `history` or `coarse`.
 * @param requestChars - characters in the user message the estimate was about.
 */
export function sourceBucket(source: 'history' | 'coarse', requestChars: number): string {
  return `${source}|${sizeBucket(requestChars)}`
}

/**
 * Median of a sample set; keeps outliers from dragging the correction.
 * @param values - the samples.
 * @returns the median, or null for an empty set.
 */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle] ?? null
  const low = sorted[middle - 1]
  const high = sorted[middle]
  if (low === undefined || high === undefined) return null
  return (low + high) / 2
}

/**
 * Multiplier for a set of ratios.
 *
 * Uses a trimmed median once there are enough samples: the top and bottom tenth
 * are dropped first, because one interrupted turn (ratio 0.05) or one turn that
 * ran overnight (ratio 9) moves a plain median when the bucket is small. With
 * fewer than {@link TRIM_MIN_SAMPLES} samples the plain median is the best
 * available estimate and a trim would drop real signal.
 * @param ratios - measured `actual / predicted` values.
 * @returns the clamped trimmed median, or null while there are too few samples.
 */
export function factorFor(ratios: readonly number[]): number | null {
  if (ratios.length < MIN_SAMPLES_FOR_FACTOR) return null
  const centre = median(trimOutliers(ratios))
  if (centre === null || !Number.isFinite(centre)) return null
  return Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, centre))
}

/** Samples needed before the tails are worth trimming. */
export const TRIM_MIN_SAMPLES = 5

/**
 * Drop the extreme tenth from both ends.
 * @param ratios - the raw samples.
 * @returns the middle, or the input when there is nothing worth trimming.
 */
export function trimOutliers(ratios: readonly number[]): number[] {
  if (ratios.length < TRIM_MIN_SAMPLES) return [...ratios]
  const sorted = [...ratios].sort((left, right) => left - right)
  // At least one from each end once trimming is on: a tenth of five samples is
  // zero, and the smallest buckets are exactly where one abort does the damage.
  const cut = Math.max(1, Math.floor(sorted.length / 10))
  if (sorted.length - cut * 2 < 1) return sorted
  return sorted.slice(cut, sorted.length - cut)
}


/** Clamp one measured ratio into the range that can teach anything. */
export function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, value))
}

/**
 * The per-bucket ratio store.
 *
 * Reading never throws: a missing or corrupt file simply means "no samples
 * yet", and a failed write keeps the in-memory samples so the current session
 * still calibrates.
 */
export class CalibrationStore {
  private buckets: Record<string, number[]>
  private readonly file: string

  /** @param file - absolute path; defaults to `calibration.json` beside the settings. */
  constructor(file: string = join(settingsDirectory(), 'calibration.json')) {
    this.file = file
    this.buckets = this.read()
  }

  /** Path of the backing file. */
  get path(): string {
    return this.file
  }

  /**
   * Record one measured turn.
   * @param bucket - the bucket the prediction belonged to.
   * @param ratio - `actual / predicted` minutes.
   * @returns the bucket after the sample landed.
   */
  record(bucket: string, ratio: number): CalibrationView {
    const samples = this.buckets[bucket] ?? []
    samples.push(clampRatio(ratio))
    while (samples.length > MAX_RATIOS_PER_BUCKET) samples.shift()
    this.buckets = { ...this.buckets, [bucket]: samples }
    this.write()
    return this.view(bucket)
  }

  /**
   * Read one bucket.
   * @param bucket - the bucket key.
   * @returns samples, median ratio and the multiplier to apply.
   */
  view(bucket: string): CalibrationView {
    const samples = this.buckets[bucket] ?? []
    return {
      bucket,
      samples: samples.length,
      medianRatio: median(samples),
      factor: factorFor(samples),
    }
  }

  /** Every bucket, for the settings page. */
  snapshot(): Record<string, CalibrationView> {
    const result: Record<string, CalibrationView> = {}
    for (const bucket of Object.keys(this.buckets)) result[bucket] = this.view(bucket)
    return result
  }

  /** Forget everything; used by the settings page. */
  clear(): void {
    this.buckets = {}
    this.write()
  }

  private read(): Record<string, number[]> {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as { buckets?: unknown }
      const buckets = parsed.buckets
      if (typeof buckets !== 'object' || buckets === null) return {}
      const result: Record<string, number[]> = {}
      for (const [bucket, value] of Object.entries(buckets as Record<string, unknown>)) {
        if (!Array.isArray(value)) continue
        const ratios = value
          .filter((item): item is number => typeof item === 'number' && Number.isFinite(item))
          .map(clampRatio)
          .slice(-MAX_RATIOS_PER_BUCKET)
        if (ratios.length > 0) result[bucket] = ratios
      }
      return result
    } catch {
      return {}
    }
  }

  private write(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const temporary = `${this.file}.tmp`
      writeFileSync(temporary, `${JSON.stringify({ version: 1, buckets: this.buckets }, null, 2)}\n`, 'utf8')
      renameSync(temporary, this.file)
    } catch {
      // A read-only home only loses the correction, never the preflight.
    }
  }
}

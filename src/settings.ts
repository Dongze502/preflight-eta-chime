/**
 * Settings for the three preflight-eta-chime modules.
 *
 * The host half owns the file; the browser half reads and writes it through
 * the HTTP routes in `./server.ts`. Nothing here throws on bad input: every
 * field is coerced back into range so a hand-edited file cannot break the
 * plugin, and a partial POST only replaces the fields it names.
 * @module preflight-eta-chime/settings
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Ring tones the browser half knows how to play. */
export const RINGTONE_IDS = ['ding', 'success', 'chime', 'bell', 'pop', 'custom'] as const

/** Languages the preflight analysis may be written in. */
export const ANALYSIS_LANGUAGE_IDS = ['zh', 'en'] as const

/** One selectable analysis language. */
export type AnalysisLanguageId = (typeof ANALYSIS_LANGUAGE_IDS)[number]

/** One selectable ring tone id. */
export type RingtoneId = (typeof RINGTONE_IDS)[number]

/** The persisted settings document. */
export interface PluginSettings {
  /** Enables the manual preflight button and endpoint. */
  preflightEnabled: boolean
  /** Enables the live ETA pill. */
  etaEnabled: boolean
  /** Enables the completion chime and its system notification. */
  chimeEnabled: boolean
  /** Stay silent when another installed plugin already notifies on completion. */
  chimeRespectNotifiers: boolean
  /** Learn from every finished turn, not only from turns that ran a preflight. */
  learnFromTurns: boolean
  /** Selected ring tone; `custom` plays `customRingtoneUrl`. */
  ringtone: RingtoneId
  /** `data:` URL, https URL, or absolute local path for the custom tone. */
  customRingtoneUrl: string | null
  /** Playback volume in `[0, 1]`. */
  volume: number
  /** Language the estimator writes `basis` and `risk_flags` in. */
  analysisLanguage: AnalysisLanguageId
  /** Upper bound on one preflight activation, in milliseconds. */
  preflightTimeoutMs: number
}

/** Settings used when the file is missing or a field cannot be read. */
export const DEFAULT_SETTINGS: PluginSettings = Object.freeze({
  preflightEnabled: true,
  etaEnabled: true,
  chimeEnabled: true,
  chimeRespectNotifiers: true,
  learnFromTurns: true,
  ringtone: 'ding',
  customRingtoneUrl: null,
  volume: 0.7,
  analysisLanguage: 'zh',
  preflightTimeoutMs: 8000,
})

/** Bounds enforced on the preflight timeout. */
export const PREFLIGHT_TIMEOUT_MS = { min: 1_000, max: 60_000 } as const

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function asRingtone(value: unknown, fallback: RingtoneId): RingtoneId {
  return RINGTONE_IDS.includes(value as RingtoneId) ? (value as RingtoneId) : fallback
}

function asVolume(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? clamp(value, 0, 1) : fallback
}

function asLanguage(value: unknown, fallback: AnalysisLanguageId): AnalysisLanguageId {
  return ANALYSIS_LANGUAGE_IDS.includes(value as AnalysisLanguageId)
    ? (value as AnalysisLanguageId)
    : fallback
}

function asTimeout(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.round(clamp(value, PREFLIGHT_TIMEOUT_MS.min, PREFLIGHT_TIMEOUT_MS.max))
}

function asCustomUrl(value: unknown, fallback: string | null): string | null {
  if (value === null) return null
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * Merge a partial, untrusted settings document over a trusted base.
 * @param raw - the value read from disk or posted by the browser half.
 * @param base - the settings to fall back to field by field.
 * @returns a complete, in-range settings document.
 */
export function normalizeSettings(raw: unknown, base: PluginSettings = DEFAULT_SETTINGS): PluginSettings {
  const source = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  return {
    preflightEnabled: asBoolean(source.preflightEnabled, base.preflightEnabled),
    etaEnabled: asBoolean(source.etaEnabled, base.etaEnabled),
    chimeEnabled: asBoolean(source.chimeEnabled, base.chimeEnabled),
    chimeRespectNotifiers: asBoolean(source.chimeRespectNotifiers, base.chimeRespectNotifiers),
    learnFromTurns: asBoolean(source.learnFromTurns, base.learnFromTurns),
    ringtone: asRingtone(source.ringtone, base.ringtone),
    customRingtoneUrl: asCustomUrl(source.customRingtoneUrl, base.customRingtoneUrl),
    volume: asVolume(source.volume, base.volume),
    analysisLanguage: asLanguage(source.analysisLanguage, base.analysisLanguage),
    preflightTimeoutMs: asTimeout(source.preflightTimeoutMs, base.preflightTimeoutMs),
  }
}

/** Directory the plugin owns under the DSH home. */
export function settingsDirectory(): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'preflight-eta-chime')
}

/**
 * A tiny JSON settings file with atomic replacement.
 *
 * Every failure mode degrades: an unreadable or corrupt file falls back to
 * defaults, and an unwritable file keeps the in-memory value so the current
 * session still behaves as configured.
 */
export class SettingsStore {
  private current: PluginSettings
  private readonly file: string

  /** @param file - absolute settings path; defaults to the plugin directory under the DSH home. */
  constructor(file: string = join(settingsDirectory(), 'settings.json')) {
    this.file = file
    this.current = this.read()
  }

  /** The cached settings document. */
  get value(): PluginSettings {
    return this.current
  }

  /** Path of the backing file. */
  get path(): string {
    return this.file
  }

  /** Whether the backing file exists, so first-run config can seed it. */
  get exists(): boolean {
    return existsSync(this.file)
  }

  /**
   * Merge a partial document and persist it.
   * @param patch - fields to replace; unknown or invalid fields are ignored.
   * @returns the merged settings.
   */
  update(patch: unknown): PluginSettings {
    this.current = normalizeSettings(patch, this.current)
    this.write(this.current)
    return this.current
  }

  private read(): PluginSettings {
    try {
      return normalizeSettings(JSON.parse(readFileSync(this.file, 'utf8')))
    } catch {
      return { ...DEFAULT_SETTINGS }
    }
  }

  private write(value: PluginSettings): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const temporary = `${this.file}.tmp`
      writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
      renameSync(temporary, this.file)
    } catch {
      // Keep the in-memory value: a read-only profile must not break the session.
    }
  }
}

/**
 * Neighbour detection for the completion chime.
 *
 * Several plugins already ring, toast or push when a turn ends. Ringing on top
 * of one of them is noise, so the settings offer "stay quiet when another
 * notifier is installed" and this module answers "is one installed?" by reading
 * the profile's bundle list. It is best-effort by design: an unreadable profile
 * means "no neighbours", which keeps the chime working.
 * @module preflight-eta-chime/notifiers
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Bundles known to notify on turn completion.
 *
 * Matched against the profile's `dsh.profile.bundles` entries. Names come from
 * the dshmarket registry; the list is intentionally explicit instead of
 * keyword matching, so a stranger named "notify-lite" does not silence us.
 */
export const KNOWN_NOTIFIER_BUNDLES = [
  'dsh-pharos',
  'dsh-notification',
  'dsh-localnotify',
  'dsh-voice-alert',
  'dsh-capybara-notify',
  'task-complete-notify-for-dsh',
  'dsh-desktop-notify',
  'dsh-notify',
] as const

/** Where the profile and its bundle list live. */
export interface NotifierProbe {
  /** DSH home; defaults to `$DSH_HOME` or `~/.dsh`. */
  home?: string
  /** Profile name; defaults to `$DSH_PROFILE` or `desktop`. */
  profile?: string
}

function registryName(bundle: string): string {
  const trimmed = bundle.trim()
  const at = trimmed.lastIndexOf('@')
  if (at > 0) return trimmed.slice(0, at)
  return trimmed
}

/**
 * Read the profile's bundle list.
 * @param probe - overrides for tests.
 * @returns bundle names, or an empty list when the profile cannot be read.
 */
export function readProfileBundles(probe: NotifierProbe = {}): string[] {
  const home = probe.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const profile = probe.profile ?? process.env.DSH_PROFILE ?? 'desktop'
  try {
    const text = readFileSync(join(home, 'profiles', profile, 'package.json'), 'utf8')
    const parsed = JSON.parse(text) as { dsh?: { profile?: { bundles?: unknown } } }
    const bundles = parsed.dsh?.profile?.bundles
    if (!Array.isArray(bundles)) return []
    return bundles.filter((item): item is string => typeof item === 'string').map(item => item.trim())
  } catch {
    return []
  }
}

/**
 * Bundles installed in this profile that already notify on completion.
 * @param probe - overrides for tests.
 * @returns the matching bundle names, in profile order.
 */
export function detectNotifierBundles(probe: NotifierProbe = {}): string[] {
  const known = new Set<string>(KNOWN_NOTIFIER_BUNDLES)
  const found: string[] = []
  for (const bundle of readProfileBundles(probe)) {
    const name = registryName(bundle)
    if (!known.has(name)) continue
    if (!found.includes(name)) found.push(name)
  }
  return found
}

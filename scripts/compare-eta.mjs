// Diagnose whether the preflight card and the ETA pill ever disagree.
// Builds the real PreflightServer with a stubbed subagent runtime, then compares
// the `result` the card shows with the `eta` the pill shows, in three states:
// idle (just estimated), running (a step is in flight), and finished.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'eta-compare-'))
const { PreflightServer } = await import('../lib/server.js')
const { EtaTracker } = await import('../lib/eta.js')
const { SettingsStore } = await import('../lib/settings.js')

const answer = JSON.stringify({ complexity: 'medium', minutes_p50: 1.5, minutes_p90: 3, basis: '读两个文件' })
const subagents = {
  async startActivation() {
    return {
      childId: 'child',
      name: 'preflight-estimator',
      result: Promise.resolve({
        output: [{ type: 'text', text: answer }],
        stopReason: 'completed',
      }),
      dispose: async () => {},
    }
  },
}
const messages = [
  { id: 'u1', role: 'user', content: [{ type: 'text', text: '把两个配置文件读一遍，然后总结差异' }] },
]
const session = { id: 's1', seq: 4, header: { cwd: '/tmp' }, deriveMessages: () => messages }
const store = new SettingsStore()
const tracker = new EtaTracker()
const preflights = new Map()
const server = new PreflightServer({
  settings: store,
  eta: tracker,
  subagents: () => subagents,
  agents: () => ({ get: () => ({ id: 's1' }) }),
  sessions: () => ({ get: id => (id === 's1' ? session : undefined), list: () => [session] }),
  preflightFor: id => preflights.get(id),
  rememberPreflight: (id, result) => preflights.set(id, result),
  calibration: () => undefined,
  notifiers: () => [],
})

const fmt = view => `${view.minutesP50}–${view.minutesP90} (source=${view.source}, state=${view.state})`
const idle = await server.estimate({ sessionId: 's1' })
console.log('idle   card:', idle.body.result.minutesP50, '-', idle.body.result.minutesP90)
console.log('idle   pill:', fmt(idle.body.eta))

// A turn starts and one step finishes: the pill should count down.
tracker.observe('s1', 'turn/start')
tracker.observe('s1', 'step/start')
await new Promise(resolve => setTimeout(resolve, 60))
tracker.observe('s1', 'step/end')
const running = server.etaView('s1')
console.log('running pill:', fmt(running), 'card still', idle.body.result.minutesP50, '-', idle.body.result.minutesP90)

tracker.observe('s1', 'turn/end')
const finished = server.etaView('s1')
console.log('finished pill:', fmt(finished))
server.close()

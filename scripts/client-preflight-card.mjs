import { readFileSync } from 'node:fs'

const source = readFileSync('client.js', 'utf8')
let loaded = null
globalThis.window = {
  __ModuleLoader__: { load: plugin => { loaded = plugin } },
  addEventListener() {},
  removeEventListener() {},
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  location: { origin: 'http://127.0.0.1:53364' },
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  Notification: function Notification() {},
  fetch: async () => ({ json: async () => ({}) }),
}
globalThis.fetch = globalThis.window.fetch

const queue = []
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  Fragment: 'Fragment',
  useState(initial) {
    const next = queue.shift()
    return [next === undefined ? (typeof initial === 'function' ? initial() : initial) : next, () => {}]
  },
  useEffect() {},
  useRef: value => ({ current: value }),
  useMemo: factory => factory(),
  useCallback: fn => fn,
  useSyncExternalStore: (_s, getSnapshot) => getSnapshot(),
  createContext: value => ({ _value: value }),
  useContext: ctx => ctx?._value ?? {},
}

new Function('window', source)(globalThis.window)
const captured = []
loaded.factory(() => React).apply({
  effect: fn => fn(),
  slots: {
    inject(_n, fn) { captured.push(fn()) },
    register: (entry, component) => ({ name: entry.name, id: entry.id ?? entry.key, component }),
  },
  locale: { register: () => () => {} },
})

const result = {
  ok: true,
  complexity: 'medium',
  minutesP50: 1.5,
  minutesP90: 3,
  riskFlags: ['preflight_timeout', '对话里有很大的任务'],
  basis: '读取两个文件并汇总',
  degraded: false,
  cached: true,
  calibration: { bucket: 'medium|short', factor: 0.62, samples: 7 },
}

const entries = captured.filter(entry => entry && entry.name === 'conversation.composer.dock')
const preflight = entries.find(entry => entry.id === 'preflight')
if (!preflight) throw new Error('preflight button missing')
// props: settings store, then component state {status,result,eta,signals}, then busy flags
queue.length = 0
queue.push({
  status: 'done',
  result,
  eta: { state: 'idle', minutesP50: 1.5, minutesP90: 3, source: 'preflight', basis: result.basis },
  signals: '本轮用户消息 120 字',
})
const texts = []
const walk = node => {
  if (node === null || node === undefined || typeof node === 'boolean') return
  if (Array.isArray(node)) { for (const child of node) walk(child); return }
  if (typeof node === 'string' || typeof node === 'number') { texts.push(String(node)); return }
  if (typeof node.type === 'function') { walk(node.type({ ...node.props, children: node.children })); return }
  for (const child of node.children ?? []) walk(child)
}
walk(preflight.component({ sessionId: 'session-1', t: key => key }))
const flat = texts.join(' | ')
console.log('preflight card text:', flat.slice(0, 300))
for (const expected of ['calibrationApplied', 'cachedBadge', 'basisLabel', 'riskFlags']) {
  if (!flat.includes(expected)) throw new Error(`preflight card must show "${expected}"`)
}
console.log('preflight card: OK')

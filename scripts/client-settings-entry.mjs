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
}

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
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  createContext: value => ({ Provider: null, _value: value }),
  useContext: ctx => (ctx && ctx._value) ?? {},
}
const requireStub = name => {
  if (name === 'react') return React
  throw new Error('unexpected require ' + name)
}

new Function('window', source)(globalThis.window)
const plugin = loaded.factory(requireStub)
const captured = []
const ctx = {
  slots: {
    inject(_name, fn) { captured.push(fn()) },
    register(entry, component) { return { name: entry.name, id: entry.id ?? entry.key, component } },
  },
  locale: { register: (ns, lang, dict) => ({ ns, lang, dict }) },
  on: () => () => {},
  effect: () => () => {},
}
plugin.apply(ctx)
const pillEntry = captured.find(entry => entry && entry.name === 'conversation.composer.dock')
if (!pillEntry) throw new Error('ETA pill not registered')

queue.push(null, null, true, true) // settings store, eta store, popover open, settings dialog open
const tree = pillEntry.component({ sessionId: 'session-1', t: key => key })

const texts = []
const walk = node => {
  if (node === null || node === undefined || node === false || node === true) return
  if (Array.isArray(node)) {
    for (const child of node) walk(child)
    return
  }
  if (typeof node === 'string' || typeof node === 'number') {
    texts.push(String(node))
    return
  }
  if (typeof node.type === 'function') {
    walk(node.type({ ...node.props, children: node.children }))
    return
  }
  for (const child of node.children ?? []) walk(child)
}
walk(tree)
const flat = texts.join(' | ')
console.log('rendered text:', flat.slice(0, 240))
for (const expected of ['openSettings', 'settingsTitle', 'close']) {
  if (!flat.includes(expected)) throw new Error(`expected "${expected}" in the rendered pill`)
}

// Render the settings form itself once settings have arrived: this is the path
// that crashed the live renderer when a value was referenced but never read.
const panelEntry = captured.find(entry => entry && entry.name === 'plugins.row.config')
if (!panelEntry) throw new Error('settings panel not registered')
queue.push(
  { preflightEnabled: true, etaEnabled: true, chimeEnabled: true, ringtone: 'ding', customRingtoneUrl: null, volume: 0.7, analysisLanguage: 'zh', chimeRespectNotifiers: true },
  '',
  false,
)
const panelTexts = []
const panelTree = panelEntry.component({ t: key => key })
const collect = node => {
  if (node === null || node === undefined || node === false || node === true) return
  if (Array.isArray(node)) { for (const child of node) collect(child); return }
  if (typeof node === 'string' || typeof node === 'number') { panelTexts.push(String(node)); return }
  if (typeof node.type === 'function') { collect(node.type({ ...node.props, children: node.children })); return }
  for (const child of node.children ?? []) collect(child)
}
collect(panelTree)
const panelFlat = panelTexts.join(' | ')
console.log('settings form text:', panelFlat.slice(0, 200))
for (const expected of ['enablePreflight', 'analysisLanguage', 'respectNotifiers', 'learnFromTurns', 'volume']) {
  if (!panelFlat.includes(expected)) throw new Error(`expected "${expected}" in the settings form`)
}
console.log('settings entry point: OK')

/**
 * Component test with a real DOM and the real React.
 *
 * The other client tests stub React down to a function that records element
 * trees; that catches a missing binding only when the stubbed branch happens to
 * run with a value that reaches it. This file mounts the actual bundle into
 * jsdom and clicks it, so a `ReferenceError` thrown while rendering (the crash
 * that made the pill vanish) fails here even if no stub path touched it.
 *
 * @module preflight-eta-chime/test/client.dom.test
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { JSDOM } from 'jsdom'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

const here = dirname(fileURLToPath(import.meta.url))
const bundlePath = join(here, '..', 'client.js')

const SETTINGS = {
  preflightEnabled: true,
  etaEnabled: true,
  chimeEnabled: true,
  chimeRespectNotifiers: true,
  learnFromTurns: true,
  analysisLanguage: 'zh',
  ringtone: 'ding',
  customRingtoneUrl: null,
  volume: 0.7,
  preflightTimeoutMs: 8000,
}

const ESTIMATE = {
  ok: true,
  complexity: 'medium',
  minutesP50: 1.4,
  minutesP90: 2.9,
  riskFlags: [],
  degraded: false,
  basis: '读了三个文件',
}

function jsonResponse(status, body) {
  return {
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

function createFetchStub() {
  const calls = []
  const fetchStub = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body === undefined ? null : JSON.parse(init.body) })
    if (String(url).endsWith('/api/preflight/estimate')) {
      return jsonResponse(200, {
        result: ESTIMATE,
        eta: { state: 'idle', minutesP50: 1.4, minutesP90: 2.9, elapsedMs: 0, stepsDone: 0, complexity: 'medium', preflightDegraded: false, priorWeight: 1, source: 'preflight', basis: ESTIMATE.basis },
        signals: '本轮用户消息 30 字',
        calibration: { bucket: 'medium|short', samples: 0, medianRatio: null, factor: null },
      })
    }
    if (String(url).endsWith('/api/preflight-chime/settings')) {
      if (init.method === 'POST') {
        return jsonResponse(200, { ok: true, settings: JSON.parse(init.body), notifiers: ['dsh-pharos'], calibration: {} })
      }
      return jsonResponse(200, {
        ok: true,
        settings: SETTINGS,
        notifiers: ['dsh-pharos'],
        calibration: { 'coarse|short': { bucket: 'coarse|short', samples: 2, medianRatio: 0.5, factor: 0.5 } },
      })
    }
    return jsonResponse(404, { ok: false })
  }
  return { fetchStub, calls }
}

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1:5063/', pretendToBeVisual: true })
  const { window } = dom
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'CustomEvent', 'FileReader', 'Notification', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    if (window[key] !== undefined) globalThis[key] = window[key]
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  return window
}

function loadPlugin(window) {
  const loaded = {}
  window.__ModuleLoader__ = {
    load(registration) {
      loaded.registration = registration
    },
  }
  new Function('window', readFileSync(bundlePath, 'utf8'))(window)
  const registration = loaded.registration
  const requireShim = name => {
    if (name === 'react') return React
    throw new Error(`unexpected require(${JSON.stringify(name)})`)
  }
  const plugin = registration.factory(requireShim)
  const entries = new Map()
  const ctx = {
    effect(fn) {
      fn()
    },
    locale: { register() { return () => {} } },
    slots: {
      inject(_name, callback) {
        callback()
      },
      register(entry, Component) {
        entries.set(entry.id ?? entry.key, { entry, Component })
        return () => entries.delete(entry.id ?? entry.key)
      },
    },
  }
  plugin.apply(ctx)
  return { registration, entries }
}

async function flush(times = 6) {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

async function mount(window, Component, props) {
  const container = window.document.createElement('div')
  window.document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(React.createElement(Component, props))
  })
  await flush()
  return { container, unmount: () => act(() => root.unmount()) }
}

function clickable(window, container, text) {
  const candidates = [...container.querySelectorAll('button, [role="button"], label, span, div')]
  const hit = candidates.filter(node => (node.textContent ?? '').includes(text)).pop()
  assert.ok(hit !== undefined, `no element containing ${JSON.stringify(text)}; body was ${container.textContent}`)
  return hit
}

async function click(window, element) {
  await act(async () => {
    element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  await flush()
}

test('the ETA popover opens a working settings dialog in a real DOM', async () => {
  const window = setupDom()
  const { fetchStub, calls } = createFetchStub()
  globalThis.fetch = fetchStub
  const { entries } = loadPlugin(window)
  const pill = entries.get('eta')
  assert.ok(pill !== undefined, 'the composer dock registers the pill')

  const { container, unmount } = await mount(window, pill.Component, { sessionId: 'session-1', t: key => key })

  await click(window, clickable(window, container, '⏱'))
  const popover = container.textContent ?? ''
  assert.match(popover, /openSettings/u, 'the ETA popover offers a settings entry')

  await click(window, clickable(window, container, 'openSettings'))
  const dialog = window.document.body.textContent ?? ''
  assert.match(dialog, /settingsTitle/u, 'the dialog renders the settings form title')
  assert.match(dialog, /respectNotifiers/u, 'the form exposes the notifier coexistence switch')
  assert.match(dialog, /learnedSamples/u, 'the form shows how many samples were learned')

  const switchLabel = [...window.document.querySelectorAll('label')].find(node => (node.textContent ?? '').includes('respectNotifiers'))
  assert.ok(switchLabel !== undefined, 'the switch has a label row')
  const switchInput = switchLabel.querySelector('input[type="checkbox"]')
  assert.ok(switchInput !== undefined)
  assert.equal(switchInput.checked, true, 'the switch starts on, as configured')

  // `click()` runs the checkbox activation behaviour, which is what React's
  // controlled change handler observes; assigning `checked` and dispatching a
  // bare event leaves React's state untouched.
  await act(async () => {
    switchInput.click()
  })
  await flush()

  await click(window, clickable(window, container, 'save'))
  const saved = calls.filter(call => call.method === 'POST' && call.url.endsWith('/settings')).at(-1)
  assert.ok(saved !== undefined, 'saving posts the settings')
  assert.equal(saved.body.chimeRespectNotifiers, false, 'the toggle reaches the request body')

  unmount()
  delete globalThis.window
})

test('the preflight card renders the estimate, basis and signals in a real DOM', async () => {
  const window = setupDom()
  const { fetchStub } = createFetchStub()
  globalThis.fetch = fetchStub
  const { entries } = loadPlugin(window)
  const button = entries.get('preflight')
  assert.ok(button !== undefined, 'the composer dock registers the preflight button')

  const { container, unmount } = await mount(window, button.Component, { sessionId: 'session-1', t: key => key })
  await click(window, clickable(window, container, 'preflight'))

  const card = container.textContent ?? ''
  assert.match(card, /preflightEstimate/u, 'the card shows an estimate')
  assert.match(card, /中/u, 'a medium complexity is labelled in Chinese')
  assert.match(card, /1–3 分钟/u, 'the card shows the p50–p90 range from the host')
  assert.match(card, /读了三个文件/u, 'the basis sentence is shown')
  assert.match(card, /signalsLabel/u, 'the input signals are shown')

  unmount()
  delete globalThis.window
})

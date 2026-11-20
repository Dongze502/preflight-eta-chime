/**
 * Acceptance tests for preflight-eta-chime.
 *
 * Run with `node test/index.test.mjs` (process-internal, no child processes:
 * the sandbox refuses `node --test` spawns).
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const { apply, inject, name } = await import('../lib/index.js')
const { SettingsStore, DEFAULT_SETTINGS, normalizeSettings, PREFLIGHT_TIMEOUT_MS } = await import('../lib/settings.js')
const { runPreflight, buildTranscript, parseAnswer, interpretAnswer, PREFLIGHT_PROMPT, promptFor, ANALYSIS_LANGUAGES } = await import('../lib/preflight.js')
const { EtaTracker, fuseEta, priorWeight } = await import('../lib/eta.js')
const { PreflightServer, ROUTES, isTrustedRequest } = await import('../lib/server.js')
const { CalibrationStore, bucketKey, sizeBucket, median, factorFor, trimOutliers, clampRatio, MAX_FACTOR, MIN_FACTOR } = await import('../lib/calibration.js')
const { detectNotifierBundles, readProfileBundles } = await import('../lib/notifiers.js')

// Keep the plugin's settings file inside the test sandbox.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'preflight-home-'))

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function settingsDirectoryForTest() {
  return join(process.env.DSH_HOME, 'preflight-eta-chime')
}

function fakeSession(id = 's1', extra = {}) {
  return {
    id,
    header: { cwd: 'C:/work/demo', ...extra },
    deriveMessages: () => [
      { role: 'user', content: [{ type: 'text', text: '帮我重构这个插件' }] },
      { role: 'assistant', content: [{ type: 'text', text: '先拆成三步：读契约、写宿主半、写客户端半。' }] },
      { role: 'assistant', content: [{ type: 'reasoning', text: '内部推理不应进入转写' }] },
      { role: 'tool', content: [{ type: 'text', text: '工具输出也不应进入转写' }] },
    ],
  }
}

function fakeResult(stopReason, structured) {
  return { stopReason, output: [{ type: 'text', text: JSON.stringify(structured ?? {}) }], structured }
}

function fakeSubagents({ result = fakeResult('completed'), delayMs = 0, onDispose } = {}) {
  const calls = []
  return {
    calls,
    startActivation(spec) {
      calls.push(spec)
      let disposed = false
      return Promise.resolve({
        childId: 'child-1',
        name: 'preflight-estimator',
        result: delayMs >= 0 ? new Promise(resolve => setTimeout(() => resolve(result), delayMs)) : new Promise(() => {}),
        async dispose() {
          disposed = true
          onDispose?.(disposed)
        },
        get disposed() {
          return disposed
        },
      })
    },
  }
}

function fakeCtx() {
  const handlers = []
  const effects = []
  const disposers = []
  const routes = []
  const services = {
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    subagents: undefined,
  }
  const ctx = {
    sessions: { get: id => (id === 's1' || id === 's2' ? fakeSession(id) : undefined) },
    get(key) {
      if (key === 'agents') return { get: () => ({ id: 's1' }) }
      return undefined
    },
    effect(fn, _label) {
      const disposer = fn()
      effects.push(disposer)
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
    on(event, handler) {
      if (event === 'session/event') handlers.push(handler)
      return () => {}
    },
    inject(deps, callback) {
      const child = { ...ctx, [deps[0]]: services[deps[0]] }
      const disposer = callback(child)
      if (typeof disposer === 'function') disposers.push(disposer)
      return () => {}
    },
  }
  return { ctx, handlers, routes, services, disposers }
}

function fakeResponse() {
  const writes = []
  return {
    writes,
    headers: undefined,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    write(chunk) {
      writes.push(String(chunk))
    },
    end(chunk) {
      if (typeof chunk === 'string') writes.push(chunk)
    },
    on() {},
  }
}

function fakeRequest(body, method = 'POST', headers = { host: '127.0.0.1:5' }) {
  const listeners = new Map()
  const req = {
    method,
    headers,
    url: '/',
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return req
    },
    destroy() {},
  }
  queueMicrotask(() => {
    const text = body === undefined ? '' : JSON.stringify(body)
    if (text !== '') for (const handler of listeners.get('data') ?? []) handler(Buffer.from(text))
    for (const handler of listeners.get('end') ?? []) handler()
  })
  return req
}

async function callRoute(route, body, res = fakeResponse(), method = 'POST') {
  await route.handler(fakeRequest(body, method), res)
  const text = res.writes.join('')
  const start = text.indexOf('{')
  const json = start === -1 ? null : JSON.parse(text.slice(start))
  return { status: res.status, body: json, raw: text }
}

function sseFrames(writes, kind) {
  return writes.filter(chunk => chunk.includes(`event: ${kind}`))
}

// ---------------------------------------------------------------------------
// Module 1 — preflight
// ---------------------------------------------------------------------------

test('the preflight prompt scopes the estimate to the next answer, not the project', () => {
  assert.match(PREFLIGHT_PROMPT, /只读的任务预检器/u)
  assert.match(PREFLIGHT_PROMPT, /"minutes_p50"/u)
  assert.match(PREFLIGHT_PROMPT, /"insufficient_context"/u)
  // The conversation is background; the object of the estimate is one answer.
  assert.match(PREFLIGHT_PROMPT, /只是背景/u)
  assert.match(PREFLIGHT_PROMPT, /它不是要执行的任务/u)
  assert.match(PREFLIGHT_PROMPT, /助手接下来要写的这一条答复/u)
  assert.match(PREFLIGHT_PROMPT, /不要因为对话里出现过很大的任务/u)
  assert.match(PREFLIGHT_PROMPT, /0\.5 表示半分钟/u)
  // A numeric band is mandatory, so the pill rarely goes blank.
  assert.match(PREFLIGHT_PROMPT, /两个字段都要给数字/u)
  assert.match(PREFLIGHT_PROMPT, /不要留 null/u)
  assert.match(PREFLIGHT_PROMPT, /"basis"/u)
})

test('the prompt asks for Chinese by default and can ask for English instead', () => {
  assert.deepEqual([...ANALYSIS_LANGUAGES], ['zh', 'en'])
  assert.match(promptFor(), /必须用简体中文书写/u)
  assert.match(promptFor('zh'), /必须用简体中文书写/u)
  assert.match(promptFor('en'), /in English/u)
  assert.equal(promptFor(), promptFor('zh'))
  // The base prompt carries no language rule, so the clause is the only switch.
  assert.doesNotMatch(PREFLIGHT_PROMPT, /必须用简体中文书写/u)
})

test('the transcript keeps user and assistant text only', () => {
  const text = buildTranscript(fakeSession())
  assert.match(text, /帮我重构这个插件/u)
  assert.match(text, /先拆成三步/u)
  assert.doesNotMatch(text, /内部推理/u)
  assert.doesNotMatch(text, /工具输出/u)
})

test('a non-completed stop reason degrades without reading the output', async () => {
  const subagents = fakeSubagents({ result: fakeResult('aborted', { complexity: 'high', minutes_p50: 9 }) })
  const result = await runPreflight({
    subagents,
    parent: { id: 's1' },
    transcript: '用户：做点事',
    timeoutMs: 500,
  })
  assert.equal(result.ok, false)
  assert.equal(result.degraded, true)
  assert.deepEqual(result.riskFlags, ['preflight_aborted'])
  assert.equal(result.minutesP50, undefined)
  // delivery must be caller so the main conversation keeps its own completion event.
  assert.equal(subagents.calls[0].delivery, 'caller')
  assert.equal(subagents.calls[0].provider, 'spawn')
})

test('a timeout disposes the activation and degrades', async () => {
  let disposed = false
  const subagents = fakeSubagents({ delayMs: -1, onDispose: () => { disposed = true } })
  const started = Date.now()
  const result = await runPreflight({ subagents, parent: { id: 's1' }, transcript: '用户：x', timeoutMs: 40 })
  assert.equal(result.degraded, true)
  assert.deepEqual(result.riskFlags, ['preflight_timeout'])
  assert.ok(disposed, 'dispose() must run on the timeout path')
  assert.ok(Date.now() - started < 2_000)
})

test('a missing subagent runtime degrades instead of throwing', async () => {
  const result = await runPreflight({ subagents: undefined, parent: { id: 's1' }, transcript: 'x', timeoutMs: 50 })
  assert.deepEqual(result.riskFlags, ['preflight_unavailable'])
})

test('runPreflight hands the configured analysis language to the subagent', async () => {
  const english = fakeSubagents({
    result: fakeResult('completed', { complexity: 'medium', minutes_p50: 2, minutes_p90: 4, risk_flags: ['slow build'], basis: 'needs one build' }),
  })
  await runPreflight({ subagents: english, parent: { id: 'a1' }, transcript: '用户：继续', timeoutMs: 500, language: 'en' })
  const englishPrompt = english.calls[0].prompt[0].text
  assert.match(englishPrompt, /in English/u)
  assert.doesNotMatch(englishPrompt, /必须用简体中文书写/u)

  const chinese = fakeSubagents({
    result: fakeResult('completed', { complexity: 'medium', minutes_p50: 2, minutes_p90: 4, risk_flags: ['需要构建'], basis: '要跑一次构建' }),
  })
  await runPreflight({ subagents: chinese, parent: { id: 'a1' }, transcript: '用户：继续', timeoutMs: 500 })
  assert.match(chinese.calls[0].prompt[0].text, /必须用简体中文书写/u)
})

test('a completed activation yields the parsed estimate', async () => {
  const structured = { complexity: 'medium', minutes_p50: 4, minutes_p90: 9, risk_flags: ['多步工具'] }
  const subagents = fakeSubagents({ result: fakeResult('completed', structured) })
  const result = await runPreflight({ subagents, parent: { id: 's1' }, transcript: '用户：x', timeoutMs: 500 })
  assert.equal(result.ok, true)
  assert.equal(result.degraded, false)
  assert.equal(result.complexity, 'medium')
  assert.equal(result.minutesP50, 4)
  assert.deepEqual(result.riskFlags, ['多步工具'])
})

test('prose around the JSON is tolerated', () => {
  const parsed = parseAnswer('好的，结果如下：\n```json\n{"complexity":"low","minutes_p50":1,"minutes_p90":2,"risk_flags":[]}\n```')
  assert.equal(parsed.complexity, 'low')
})

test('an unusable answer is rejected rather than guessed', () => {
  assert.equal(interpretAnswer({ complexity: 'huge', minutes_p50: 'soon' }), null)
  const unknown = interpretAnswer({ complexity: 'unknown', minutes_p50: null, minutes_p90: null })
  assert.equal(unknown.ok, false)
  assert.deepEqual(unknown.riskFlags, ['insufficient_context'])
})

// ---------------------------------------------------------------------------
// Module 2 — ETA
// ---------------------------------------------------------------------------

test('the preflight prior weighs less as execution evidence accumulates', () => {
  assert.equal(priorWeight(0), 1)
  assert.equal(priorWeight(2.5), 0.5)
  assert.equal(priorWeight(5), 0.2)
  assert.equal(priorWeight(50), 0.2)
})

test('without a preflight, evidence or history the pill still shows a coarse band', () => {
  const view = fuseEta(null, undefined)
  assert.equal(view.state, 'idle')
  assert.equal(view.source, 'coarse')
  assert.ok(typeof view.minutesP50 === 'number' && view.minutesP50 > 0)
  assert.ok(typeof view.minutesP90 === 'number' && view.minutesP90 > (view.minutesP50 ?? 0))
})

test('a preflight prior alone produces a range', () => {
  const view = fuseEta(null, { ok: true, degraded: false, riskFlags: [], complexity: 'medium', minutesP50: 4, minutesP90: 9 })
  assert.equal(view.minutesP50, 4)
  assert.equal(view.minutesP90, 9)
  assert.equal(view.complexity, 'medium')
})

test('the pill shows the preflight numbers verbatim, so it cannot drift from the card', () => {
  // Rounding here used to turn 0.96 into 1.0: the pill then said "1–2 分钟"
  // while the card, reading the raw result, said "1 分钟以内".
  const subMinute = fuseEta(null, { ok: true, degraded: false, riskFlags: [], minutesP50: 0.96, minutesP90: 1.8 })
  assert.equal(subMinute.minutesP50, 0.96)
  assert.equal(subMinute.minutesP90, 1.8)
  const exact = fuseEta(null, { ok: true, degraded: false, riskFlags: [], minutesP50: 1.44, minutesP90: 3.2 })
  assert.equal(exact.minutesP50, 1.44)
  assert.equal(exact.minutesP90, 3.2)
})

test('a half-filled answer is completed instead of rejected', () => {
  // Only the bound survived: derive the median from it.
  const onlyP90 = interpretAnswer({ complexity: 'medium', minutes_p90: 6 })
  assert.equal(onlyP90.ok, true)
  assert.ok((onlyP90.minutesP50 ?? 0) > 0 && (onlyP90.minutesP50 ?? 0) < 6)
  assert.equal(onlyP90.minutesP90, 6)
  // Only the median survived: widen it.
  const onlyP50 = interpretAnswer({ complexity: 'low', minutes_p50: 2 })
  assert.equal(onlyP50.ok, true)
  assert.ok((onlyP50.minutesP90 ?? 0) > 2)
  // Both null but a class arrived: fall back to the class band.
  const bandOnly = interpretAnswer({ complexity: 'high', minutes_p50: null, minutes_p90: null })
  assert.equal(bandOnly.ok, true)
  assert.ok((bandOnly.minutesP50 ?? 0) >= 4)
})

test('the answer keeps the basis sentence for the popover', () => {
  const answer = interpretAnswer({ complexity: 'medium', minutes_p50: 2, minutes_p90: 4, basis: '要跑一次构建' })
  assert.equal(answer.basis, '要跑一次构建')
  const long = interpretAnswer({ complexity: 'low', minutes_p50: 1, minutes_p90: 2, basis: 'x'.repeat(200) })
  assert.ok((long.basis ?? '').length <= 80)
})

test('measured pace from finished turns replaces a missing preflight', () => {
  const history = { turns: 2, avgSteps: 3, avgStepMinutes: 0.5 }
  const planned = fuseEta(null, undefined, history)
  assert.equal(planned.source, 'history')
  assert.ok((planned.minutesP50 ?? 0) > 0)
  const running = fuseEta({ elapsedMs: 30_000, stepsDone: 0, stepMs: 0 }, undefined, history)
  assert.equal(running.source, 'history')
  assert.ok((running.minutesP50 ?? 0) > 0)
})

test('execution evidence pulls the estimate toward the measured pace', () => {
  const preflight = { ok: true, degraded: false, riskFlags: [], complexity: 'high', minutesP50: 30, minutesP90: 45 }
  const view = fuseEta({ elapsedMs: 60_000, stepsDone: 2, stepMs: 50_000 }, preflight)
  assert.equal(view.state, 'running')
  assert.ok(view.minutesP50 < 30, `expected the prior to be discounted, got ${view.minutesP50}`)
  assert.ok(view.minutesP90 >= view.minutesP50)
})

test('a running turn counts the prior down instead of repeating the whole turn', () => {
  const preflight = { ok: true, degraded: false, riskFlags: [], complexity: 'medium', minutesP50: 6, minutesP90: 8 }
  const view = fuseEta({ elapsedMs: 240_000, stepsDone: 2, stepMs: 120_000 }, preflight)
  assert.equal(view.state, 'running')
  assert.ok(view.minutesP50 < 6, `expected a countdown below the turn total, got ${view.minutesP50}`)
  assert.ok(view.minutesP90 < 8, `expected the bound to count down too, got ${view.minutesP90}`)
  assert.ok(view.minutesP90 >= view.minutesP50)
})

test('the tracker folds turn and step events and ignores everything else', () => {
  const tracker = new EtaTracker()
  tracker.observe('s1', 'tool/call')
  assert.equal(tracker.evidence('s1'), null)
  tracker.observe('s1', 'turn/start')
  tracker.observe('s1', 'step/start')
  tracker.observe('s1', 'step/end')
  const evidence = tracker.evidence('s1')
  assert.equal(evidence.stepsDone, 1)
  tracker.observe('s1', 'turn/end')
  assert.equal(tracker.evidence('s1'), null)
  assert.equal(tracker.hasFinished('s1'), true)
  // The finished turn feeds the measured pace used as a preflight fallback.
  const history = tracker.history('s1')
  assert.ok(history !== null)
  assert.equal(history.turns, 1)
  assert.equal(history.avgSteps, 1)
})

// ---------------------------------------------------------------------------
// Settings persistence
// ---------------------------------------------------------------------------

test('settings round-trip and clamp hostile values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'preflight-eta-chime-'))
  try {
    const file = join(dir, 'settings.json')
    const store = new SettingsStore(file)
    assert.equal(store.exists, false)
    assert.deepEqual(store.value, DEFAULT_SETTINGS)
    const updated = store.update({ volume: 5, ringtone: 'nope', preflightTimeoutMs: 10, chimeEnabled: false })
    assert.equal(updated.volume, 1)
    assert.equal(updated.ringtone, 'ding')
    assert.equal(updated.preflightTimeoutMs, PREFLIGHT_TIMEOUT_MS.min)
    assert.equal(updated.chimeEnabled, false)
    assert.equal(store.exists, true)
    const reloaded = new SettingsStore(file)
    assert.equal(reloaded.value.volume, 1)
    assert.equal(reloaded.value.chimeEnabled, false)
    assert.equal(normalizeSettings({ volume: 'loud' }).volume, DEFAULT_SETTINGS.volume)
    // Language defaults to Chinese and only the two known ids survive.
    assert.equal(normalizeSettings({}).analysisLanguage, 'zh')
    assert.equal(normalizeSettings({ analysisLanguage: 'en' }).analysisLanguage, 'en')
    assert.equal(normalizeSettings({ analysisLanguage: 'fr' }).analysisLanguage, 'zh')
    assert.equal(store.update({ analysisLanguage: 'en' }).analysisLanguage, 'en')
    assert.equal(new SettingsStore(file).value.analysisLanguage, 'en')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Module 3 — completion notices through session/event
// ---------------------------------------------------------------------------

test('a completed turn publishes one completion frame; subagent sessions and tool/call do not', async () => {
  const { ctx, handlers, routes, services } = fakeCtx()
  apply(ctx)
  assert.equal(handlers.length, 1, 'exactly one session/event listener')

  const eventsRoute = routes.find(route => route.path === ROUTES.events)
  assert.ok(eventsRoute, 'the event stream route is registered')

  const userResponse = fakeResponse()
  await eventsRoute.handler(
    { url: `${ROUTES.events}?sessionId=s1`, headers: { host: '127.0.0.1:5' }, method: 'GET', on() {} },
    userResponse,
  )
  const childResponse = fakeResponse()
  await eventsRoute.handler(
    { url: `${ROUTES.events}?sessionId=s2`, headers: { host: '127.0.0.1:5' }, method: 'GET', on() {} },
    childResponse,
  )

  // A tool call is a session event type, not a Cordis event; it must not chime.
  handlers[0]({ ...fakeSession('s1'), header: { cwd: 'x' } }, { type: 'tool/call', data: {} })
  // A preflight child session finishing must stay silent.
  handlers[0]({ id: 's2', header: { cwd: 'C:/work/demo', origin: 'subagent' } }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(sseFrames(userResponse.writes, 'completed').length, 0)
  assert.equal(sseFrames(childResponse.writes, 'completed').length, 0)

  // The user session finishing does chime, once.
  handlers[0]({ id: 's1', header: { cwd: 'C:/work/demo' } }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  handlers[0]({ id: 's1', header: { cwd: 'C:/work/demo' } }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await new Promise(resolve => setTimeout(resolve, 30))
  const frames = sseFrames(userResponse.writes, 'completed')
  assert.equal(frames.length, 1, 'duplicate completions collapse into one frame')
  assert.match(frames[0], /"chime":true/u)
  assert.match(frames[0], /"title":"demo"/u)

  // An aborted or errored turn is not a completion.
  handlers[0]({ id: 's1', header: { cwd: 'x' } }, { type: 'turn/end', data: { reason: { kind: 'aborted' } } })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(sseFrames(userResponse.writes, 'completed').length, 1)
  assert.equal(services.subagents, undefined)
})

test('the plugin exports the profile row id and a subagents-free inject list', () => {
  assert.equal(name, 'preflight-eta-chime')
  assert.deepEqual(inject, ['sessions', 'llm', 'tools'])
  assert.equal(inject.includes('subagents'), false, 'subagents must stay optional via ctx.inject')
})

test('settings read/write route answers and broadcasts', async () => {
  const { ctx, routes } = fakeCtx()
  apply(ctx)
  const settingsRoute = routes.find(route => route.path === ROUTES.settings)
  assert.ok(settingsRoute)
  const res = fakeResponse()
  await settingsRoute.handler(
    { url: ROUTES.settings, headers: { host: '127.0.0.1:5' }, method: 'GET', on() {} },
    res,
  )
  assert.equal(res.status, 200)
  assert.match(res.writes.join(''), /"settings":/u)
})

test('loopback-only check rejects foreign hosts and cross-site requests', () => {
  assert.equal(isTrustedRequest({ headers: { host: 'evil.example:5' } }), false)
  assert.equal(isTrustedRequest({ headers: { host: '127.0.0.1:5', 'sec-fetch-site': 'cross-site' } }), false)
  assert.equal(isTrustedRequest({ headers: { host: '127.0.0.1:5', origin: 'http://127.0.0.1:6' } }), false)
  assert.equal(isTrustedRequest({ headers: { host: '127.0.0.1:5', origin: 'http://127.0.0.1:5' } }), true)
})

// ---------------------------------------------------------------------------
// Calibration, cache and notifier coexistence
// ---------------------------------------------------------------------------

test('calibration buckets by claimed complexity and request size', () => {
  assert.equal(sizeBucket(10), 'short')
  assert.equal(sizeBucket(900), 'medium')
  assert.equal(sizeBucket(5_000), 'long')
  assert.equal(bucketKey('medium', 900), 'medium|medium')
  assert.equal(bucketKey(undefined, 10), 'unknown|short')
  assert.equal(bucketKey('  high ', 10), 'high|short')
})

test('a correction needs samples before it is trusted and then stays clamped', () => {
  assert.equal(median([]), null)
  assert.equal(median([1, 2, 3]), 2)
  assert.equal(median([1, 2, 3, 4]), 2.5)
  assert.equal(factorFor([]), null)
  assert.equal(factorFor([2, 2]), null, 'two samples are not enough')
  assert.equal(factorFor([2, 2.2, 1.9]), 2)
  assert.equal(factorFor([100, 100, 100]), MAX_FACTOR)
  assert.equal(factorFor([0.001, 0.001, 0.001]), MIN_FACTOR)
  assert.equal(clampRatio(Number.NaN), 1)
  assert.equal(clampRatio(0.001), 0.05)
  assert.equal(clampRatio(1_000), 20)
})

test('one interrupted turn cannot drag the learned correction down', () => {
  // Five ordinary turns around 2x plus one aborted turn at the floor: a plain
  // median would land near 2, but the trimmed median must ignore both tails and
  // stay close to the ordinary turns.
  const ordinary = [1.9, 2.0, 2.05, 2.1, 2.2, 2.3]
  const withAbort = [...ordinary, 0.05]
  assert.ok(Math.abs(factorFor(ordinary) - 2.075) < 1e-9, 'the trimmed centre of the normal turns')
  const trimmed = factorFor(withAbort)
  assert.ok(trimmed !== null)
  assert.ok(Math.abs(trimmed - 2.05) < 0.06, `the abort should barely move the factor, got ${trimmed}`)
  assert.deepEqual(trimOutliers([0.05, 1, 2, 3, 4]), [1, 2, 3], 'the tenth is dropped from both ends')
  assert.deepEqual(trimOutliers([1, 2, 3]), [1, 2, 3], 'small buckets are left alone')
})

test('the calibration store persists medians and trims old samples', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'cal-')), 'calibration.json')
  const store = new CalibrationStore(file)
  store.record('medium|short', 2)
  store.record('medium|short', 2.2)
  assert.equal(store.view('medium|short').factor, null)
  store.record('medium|short', 1.9)
  const view = store.view('medium|short')
  assert.equal(view.samples, 3)
  assert.equal(view.factor, 2)
  assert.equal(view.medianRatio, 2)

  assert.equal(new CalibrationStore(file).view('medium|short').samples, 3)

  for (let index = 0; index < 80; index += 1) store.record('medium|short', 1)
  assert.equal(store.view('medium|short').samples, 50, 'the oldest samples fall off')
})

test('an estimate is scaled by the measured bias, and a repeat hits the cache', async () => {
  const bucket = 'medium|short'
  const seed = new CalibrationStore(join(settingsDirectoryForTest(), 'calibration.json'))
  for (let index = 0; index < 3; index += 1) seed.record(bucket, 0.5)

  const { ctx, routes, services } = fakeCtx()
  const subagents = fakeSubagents({
    result: fakeResult('completed', { complexity: 'medium', minutes_p50: 4, minutes_p90: 9, risk_flags: [], basis: '一次构建' }),
  })
  services.subagents = subagents
  apply(ctx)

  const estimateRoute = routes.find(route => route.path === ROUTES.estimate)
  assert.ok(estimateRoute)

  const first = await callRoute(estimateRoute, { sessionId: 's1' })
  assert.equal(first.status, 200)
  assert.equal(first.body.result.minutesP50, 2, '4 minutes scaled by the 0.5 median')
  assert.equal(first.body.result.minutesP90, 4.5)
  assert.equal(first.body.result.calibration.factor, 0.5)
  assert.equal(first.body.result.calibration.samples, 3)
  assert.equal(first.body.calibration.bucket, bucket)

  const second = await callRoute(estimateRoute, { sessionId: 's1' })
  assert.equal(subagents.calls.length, 1, 'the second click reuses the cached answer')
  assert.equal(second.body.result.cached, true)
  assert.equal(second.body.result.minutesP50, 2)
})

test('a finished turn teaches the calibration store with its measured ratio', async () => {
  const { ctx, handlers, routes, services } = fakeCtx()
  const subagents = fakeSubagents({
    result: fakeResult('completed', { complexity: 'high', minutes_p50: 2, minutes_p90: 4, risk_flags: [], basis: '多文件' }),
  })
  services.subagents = subagents
  apply(ctx)

  const estimateRoute = routes.find(route => route.path === ROUTES.estimate)
  await callRoute(estimateRoute, { sessionId: 's1' })

  handlers[0]({ id: 's1', header: { cwd: 'C:/work/demo' } }, { type: 'turn/start', data: { turn: 1 } })
  await new Promise(resolve => setTimeout(resolve, 60))
  handlers[0]({ id: 's1', header: { cwd: 'C:/work/demo' } }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })

  const store = new CalibrationStore(join(settingsDirectoryForTest(), 'calibration.json'))
  const bucket = 'high|short'
  assert.equal(store.view(bucket).samples, 1, 'the finished turn lands in the prediction bucket')
  assert.equal(store.view(bucket).medianRatio, 0.05)
})

test('a turn without a preflight still teaches the band that made its prediction', async () => {
  const home = mkdtempSync(join(tmpdir(), 'self-learn-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const { ctx, handlers, services } = fakeCtx()
    services.subagents = undefined // the preflight is not available here
    apply(ctx)

    const session = { id: 's2', header: { cwd: 'C:/work/demo' } }
    handlers[0](session, { type: 'turn/start', data: { turn: 1 } })
    await new Promise(resolve => setTimeout(resolve, 80))
    handlers[0](session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })

    // No preflight ever ran, so the pill showed the default band; that band is what
    // the finished turn now corrects.
    const store = new CalibrationStore(join(home, 'preflight-eta-chime', 'calibration.json'))
    assert.equal(store.view('coarse|short').samples, 1)
    assert.ok(store.view('coarse|short').medianRatio !== null)
  } finally {
    process.env.DSH_HOME = previous
  }
})

test('self-calibration can be switched off', async () => {
  const home = mkdtempSync(join(tmpdir(), 'self-learn-off-'))
  mkdirSync(join(home, 'preflight-eta-chime'), { recursive: true })
  writeFileSync(join(home, 'preflight-eta-chime', 'settings.json'), JSON.stringify({ learnFromTurns: false }), 'utf8')
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const { ctx, handlers, services } = fakeCtx()
    services.subagents = undefined
    apply(ctx)

    const session = { id: 's2', header: { cwd: 'C:/work/demo' } }
    handlers[0](session, { type: 'turn/start', data: { turn: 1 } })
    await new Promise(resolve => setTimeout(resolve, 40))
    handlers[0](session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })

    const store = new CalibrationStore(join(home, 'preflight-eta-chime', 'calibration.json'))
    assert.equal(store.view('coarse|short').samples, 0)
  } finally {
    process.env.DSH_HOME = previous
  }
})

test('a learned band factor shrinks the range the pill would show', () => {
  const plain = fuseEta(null, undefined)
  const corrected = fuseEta(null, undefined, null, { coarse: 0.5 })
  assert.equal(plain.source, 'coarse')
  assert.equal(corrected.source, 'coarse')
  assert.ok((corrected.minutesP50 ?? 0) < (plain.minutesP50 ?? 0))
  assert.ok((corrected.minutesP90 ?? 0) < (plain.minutesP90 ?? 0))
  // The history band is corrected independently of the default one.
  const history = { turns: 4, avgSteps: 3, avgStepMinutes: 0.5 }
  const withHistory = fuseEta(null, undefined, history, { history: 2 })
  const withoutFactor = fuseEta(null, undefined, history)
  assert.ok((withHistory.minutesP50 ?? 0) > (withoutFactor.minutesP50 ?? 0))
})

test('notifier detection reads the profile bundle list and matches known names', () => {
  const home = mkdtempSync(join(tmpdir(), 'notify-home-'))
  mkdirSync(join(home, 'profiles', 'desktop'), { recursive: true })
  writeFileSync(
    join(home, 'profiles', 'desktop', 'package.json'),
    JSON.stringify({ dsh: { profile: { bundles: ['dsh-pharos@1.2.3', 'dshmarket', 'dsh-session-to-doc'] } } }),
    'utf8',
  )
  assert.deepEqual(readProfileBundles({ home, profile: 'desktop' }), ['dsh-pharos@1.2.3', 'dshmarket', 'dsh-session-to-doc'])
  assert.deepEqual(detectNotifierBundles({ home, profile: 'desktop' }), ['dsh-pharos'])
  assert.deepEqual(detectNotifierBundles({ home: join(home, 'missing'), profile: 'desktop' }), [])
})

test('the settings document carries the notifier switch and defaults it on', () => {
  assert.equal(normalizeSettings({}).chimeRespectNotifiers, true)
  assert.equal(normalizeSettings({ chimeRespectNotifiers: false }).chimeRespectNotifiers, false)
  assert.equal(normalizeSettings({ chimeRespectNotifiers: 'no' }).chimeRespectNotifiers, true)
  assert.equal(DEFAULT_SETTINGS.chimeRespectNotifiers, true)
})

// ---------------------------------------------------------------------------
// Browser half — envelope and registrations
// ---------------------------------------------------------------------------

test('the client half localizes risk codes and offers a language switch', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  // Known host codes are translated in both languages; unknown model text passes through.
  assert.match(source, /preflight_timeout: '预检超时'/u)
  assert.match(source, /preflight_timeout: 'preflight timed out'/u)
  assert.match(source, /insufficient_context: '对话信息不足'/u)
  // The settings page carries the switch, defaulting to Chinese.
  assert.match(source, /analysisLanguage: '分析语言'/u)
  assert.match(source, /settings\.analysisLanguage \?\? 'zh'/u)
  assert.match(source, /h\('option', \{ value: 'en' \}, 'English'\)/u)
  // Calibration and notifier coexistence are visible where they matter.
  assert.match(source, /calibrationApplied: '已按本会话实测修正/u)
  assert.match(source, /cachedBadge: '缓存'/u)
  assert.match(source, /chimeRespectNotifiers/u)
  assert.match(source, /notifiersDetected: '同时安装/u)
  // Self-calibration is a switch, and the panel reports how much it has learned.
  assert.match(source, /learnFromTurns: '从已完成的回合学习'/u)
  assert.match(source, /learnedSamples: '已学习样本/u)
  assert.match(source, /checkbox\('learnFromTurns'/u)
})

test('the result card reads the live ETA while a turn runs', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  // Card and pill must not disagree: while the turn runs the card shows the same
  // live view the pill counts down, with the opening estimate kept underneath.
  assert.match(source, /const eta = useStore\(etaStore\)/u)
  assert.match(source, /const live = eta !== null && eta\.state === 'running'/u)
  assert.match(source, /preflightRemaining: '剩余'/u)
  assert.match(source, /preflightInitial: '初始预估'/u)
  assert.match(source, /preflightRemaining/u)
  assert.match(source, /rangeText\(live\)/u)
  // Once the turn ends the card reports the measured time the pill shows.
  assert.match(source, /const done = eta !== null && eta\.state === 'finished'/u)
  assert.match(source, /etaFinished'\)\.replace\('\{elapsed\}', minutesText/u)
})

test('the ETA popover carries its own settings entry point', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  // The Plugins page does not exist in every Host build — its settings shell can
  // be disabled, and then `plugins.row.config` is never declared. The composer
  // pill always renders, so the dialog hangs off it instead.
  assert.match(source, /openSettings: 'Settings'/u)
  assert.match(source, /openSettings: '设置'/u)
  assert.match(source, /function SettingsDialog\(props\)/u)
  assert.match(source, /h\(SettingsDialog, \{ t, onClose: \(\) => setSettingsOpen\(false\) \}\)/u)
  assert.match(source, /onClick: \(\) => \{\s*setOpen\(false\)\s*setSettingsOpen\(true\)/u)
  // The dialog closes on Escape and on an overlay click, and reuses the panel.
  assert.match(source, /event\.key === 'Escape'/u)
  assert.match(source, /h\(SettingsPanel, \{ t \}\)/u)
})

test('the settings form renders once settings arrive', async () => {
  // A component that reads an undeclared value throws only when the value is
  // actually used — i.e. after the host answers with a settings object. That
  // took the whole renderer down once, so the form is rendered for real here.
  const queue = []
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    Fragment: 'Fragment',
    useState(initial) {
      const next = queue.shift()
      return [next === undefined ? (typeof initial === 'function' ? initial() : initial) : next, () => {}]
    },
    useEffect: () => {},
    useRef: initial => ({ current: initial }),
    useCallback: fn => fn,
    useMemo: factory => factory(),
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    createContext: value => ({ _value: value }),
    useContext: context => context?._value ?? {},
  }
  let loaded = null
  globalThis.window = {
    __ModuleLoader__: { load: registration => { loaded = registration } },
    addEventListener() {},
    removeEventListener() {},
    location: { origin: 'http://127.0.0.1:53364' },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
  }
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  new Function('window', source)(globalThis.window)
  const registered = []
  const clientCtx = {
    effect: fn => fn(),
    slots: {
      inject(_name, callback) { callback() },
      register: (entry, component) => { registered.push({ entry, component }); return () => {} },
    },
    locale: { register: () => () => {} },
  }
  loaded.factory(() => react).apply(clientCtx)
  const panel = registered.find(item => item.entry.name === 'plugins.row.config')
  assert.ok(panel, 'settings panel must be registered')
  queue.push(
    {
      preflightEnabled: true, etaEnabled: true, chimeEnabled: true, ringtone: 'ding',
      customRingtoneUrl: null, volume: 0.7, analysisLanguage: 'zh', chimeRespectNotifiers: true,
    },
    '',
    false,
  )
  const texts = []
  const collect = node => {
    if (node === null || node === undefined || typeof node === 'boolean') return
    if (Array.isArray(node)) { for (const child of node) collect(child); return }
    if (typeof node === 'string' || typeof node === 'number') { texts.push(String(node)); return }
    if (typeof node.type === 'function') { collect(node.type({ ...node.props, children: node.children })); return }
    for (const child of node.children ?? []) collect(child)
  }
  collect(panel.component({ t: key => key }))
  const rendered = texts.join(' | ')
  for (const key of ['enablePreflight', 'enableEta', 'enableChime', 'analysisLanguage', 'respectNotifiers', 'volume']) {
    assert.ok(rendered.includes(key), `settings form must render "${key}"`)
  }
})

test('the client bundle registers the three UI contributions under the package id', async () => {
  const registrations = []
  const locales = []
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    Fragment: 'Fragment',
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useRef: initial => ({ current: initial }),
    useCallback: fn => fn,
  }
  let loaded = null
  globalThis.window = {
    __ModuleLoader__: {
      load(registration) {
        loaded = registration
      },
    },
    addEventListener() {},
    removeEventListener() {},
  }
  globalThis.fetch = async () => ({ json: async () => ({ settings: { etaEnabled: true } }) })
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  new Function('window', 'fetch', source)(globalThis.window, globalThis.fetch)
  assert.equal(loaded.id, 'preflight-eta-chime')

  const plugin = loaded.factory(specifier => {
    assert.equal(specifier, 'react')
    return react
  })
  assert.deepEqual(plugin.inject, ['slots', 'locale'])
  const clientCtx = {
    effect: fn => {
      const disposer = fn()
      return disposer
    },
    slots: {
      inject(_name, callback) {
        callback()
      },
      register(entry, component) {
        registrations.push({ entry, component })
        return () => {}
      },
    },
    locale: {
      register(ns, locale, dict) {
        locales.push({ ns, locale, keys: Object.keys(dict).length })
        return () => {}
      },
    },
  }
  plugin.apply(clientCtx)
  const ids = registrations.map(item => `${item.entry.name}#${item.entry.id ?? item.entry.key}`)
  assert.ok(ids.includes('conversation.composer.dock#eta'))
  assert.ok(ids.includes('conversation.composer.dock#preflight'))
  assert.ok(ids.includes('plugins.row.config#preflight-eta-chime#preflight-eta-chime'))
  assert.ok(registrations.every(item => typeof item.component === 'function'))
  assert.deepEqual(locales.map(item => item.locale).sort(), ['en', 'zh'])
})

test('the surfaces follow theme tokens instead of a fixed white', async () => {
  const source = await readFile(join(import.meta.dirname, '..', 'client.js'), 'utf8')
  assert.match(source, /var\(--dsw-alias-card-fill/u, 'the card surface uses a solid palette token')
  assert.match(source, /var\(--dsw-alias-label-primary/u, 'the label colour follows the palette')
  assert.doesNotMatch(source, /background:\s*'#[0-9a-f]{3,8}'/iu, 'no surface may hardcode a hex colour')
  assert.doesNotMatch(source, /color:\s*'#[0-9a-f]{3,8}'/iu, 'no ink may hardcode a hex colour')
})

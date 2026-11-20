/**
 * preflight-eta-chime — browser half.
 *
 * Three contributions, all optional at runtime:
 *  - `conversation.composer.dock`: the live ETA pill,
 *  - `conversation.composer.dock`: the manual preflight button,
 *  - `plugins.row.config`: the settings page (tones, volume, audio unlock).
 *
 * The browser half keeps no durable state: settings live in the host half and
 * arrive over HTTP, and live ETA arrives over the host event stream.
 */
window.__ModuleLoader__.load({
  id: 'preflight-eta-chime',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const NS = 'preflight-eta-chime'
    const ROW_KEY = 'preflight-eta-chime#preflight-eta-chime'
    const API = {
      estimate: '/api/preflight/estimate',
      settings: '/api/preflight-chime/settings',
      events: '/api/preflight-chime/events',
      resolve: '/api/preflight-chime/ringtone/resolve',
      ding: '/api/preflight-chime/ringtone/ding.wav',
    }
    const RINGTONES = [
      { id: 'ding', label: 'Ding' },
      { id: 'success', label: 'Success' },
      { id: 'chime', label: 'Chime' },
      { id: 'bell', label: 'Bell' },
      { id: 'pop', label: 'Pop' },
      { id: 'custom', label: 'Custom' },
    ]
    const STRINGS = {
      en: {
        preflight: 'Preflight',
        preflightRunning: 'Checking…',
        preflightUnavailable: 'Preflight unavailable',
        preflightEstimate: 'Estimate',
        preflightRemaining: 'Remaining',
        preflightInitial: 'Initial estimate',
        complexity: 'Complexity',
        riskFlags: 'Risk flags',
        steps: 'Steps',
        etaRunning: 'Elapsed {elapsed} · about {left} left',
        etaPlanned: '{range} · {complexity} complexity',
        etaFinished: 'Finished in {elapsed}',
        etaNone: '—',
        etaDegraded: 'Preflight unavailable, estimating from progress',
        settingsTitle: 'Preflight ETA Chime',
        openSettings: 'Settings',
        close: 'Close',
        enablePreflight: 'Preflight button',
        enableEta: 'Live ETA',
        enableChime: 'Completion chime',
        ringtone: 'Ring tone',
        volume: 'Volume',
        analysisLanguage: 'Analysis language',
        analysisLanguageHint: 'Language used for the preflight reasoning and risk notes.',
        customSource: 'Custom audio (URL or local path)',
        chooseFile: 'Choose file…',
        preview: 'Preview',
        unlockAudio: 'Unlock audio',
        unlocked: 'Audio ready',
        save: 'Save',
        saved: 'Saved',
        notificationDenied: 'Notifications are blocked by the browser',
        insufficient: 'Not enough context to judge',
        basisLabel: 'Based on',
        sourcePreflight: 'preflight judgement',
        sourceEvidence: 'current turn progress',
        sourceHistory: 'measured pace of past turns',
        sourceCoarse: 'a rough default (nothing measured yet)',
        signalsLabel: 'Context sent',
        cachedBadge: 'cached',
        calibrationApplied: 'Adjusted ×{factor} from {samples} measured turns',
        respectNotifiers: 'Stay quiet when another notifier is installed',
        respectNotifiersHint: 'Avoids ringing twice when a notification plugin is already running.',
        notifiersDetected: 'Also installed: {list}',
        learnFromTurns: 'Learn from finished turns',
        learnHint: 'Each turn compares its measured length with the number the pill showed, so later estimates need fewer preflights.',
        learnedSamples: 'Samples learned: {count}',
      },
      zh: {
        preflight: '预检',
        preflightRunning: '预检中…',
        preflightUnavailable: '预检暂不可用',
        preflightEstimate: '预检结果',
        preflightRemaining: '剩余',
        preflightInitial: '初始预估',
        complexity: '复杂度',
        riskFlags: '风险项',
        steps: '步骤',
        etaRunning: '已用 {elapsed} · 剩余约 {left}',
        etaPlanned: '预计 {range} · {complexity}复杂度',
        etaFinished: '已完成 · 用时 {elapsed}',
        etaNone: '—',
        etaDegraded: '预检不可用，按执行进度估算',
        basisLabel: '依据',
        sourcePreflight: '预检判断',
        sourceEvidence: '本轮执行进度',
        sourceHistory: '本会话已测得的节奏',
        sourceCoarse: '粗略默认值（还没有任何实测）',
        signalsLabel: '送入的上下文',
        cachedBadge: '缓存',
        calibrationApplied: '已按本会话实测修正 ×{factor}（{samples} 次样本）',
        respectNotifiers: '检测到其它通知插件时静默',
        respectNotifiersHint: '已经在跑通知插件时，避免两个插件一起响。',
        notifiersDetected: '同时安装：{list}',
        learnFromTurns: '从已完成的回合学习',
        learnHint: '每轮结束时把实际用时和药丸当时显示的数字对比，之后同样的请求就不必每次都预检。',
        learnedSamples: '已学习样本：{count}',
        settingsTitle: 'Preflight ETA Chime',
        openSettings: '设置',
        close: '关闭',
        enablePreflight: '预检按钮',
        enableEta: '实时 ETA',
        enableChime: '完成铃声',
        ringtone: '铃声',
        volume: '音量',
        analysisLanguage: '分析语言',
        analysisLanguageHint: '预检的依据说明与风险项使用的语言。',
        customSource: '自定义音频（URL 或本机绝对路径）',
        chooseFile: '选择文件…',
        preview: '试听',
        unlockAudio: '解锁音频',
        unlocked: '音频已就绪',
        save: '保存',
        saved: '已保存',
        notificationDenied: '浏览器已阻止通知',
        insufficient: '上下文不足，无法判断',
      },
    }

    const COMPLEXITY_LABEL = { low: '低', medium: '中', high: '高', unknown: '未知' }
    const COMPLEXITY_LABEL_EN = { low: 'low', medium: 'medium', high: 'high', unknown: 'unknown' }

    // Risk flags come back as stable codes from the host half (`preflight_timeout`
    // ...) plus, for real answers, model-written Chinese/English text. Known codes
    // are translated here; anything else is shown as the model wrote it.
    const RISK_LABEL = {
      zh: {
        insufficient_context: '对话信息不足',
        preflight_unavailable: '预检服务不可用',
        preflight_timeout: '预检超时',
        preflight_invalid_json: '预检结果解析失败',
        preflight_aborted: '预检被中止',
        preflight_error: '预检出错',
        preflight_max_tokens: '预检输出被截断',
        'preflight_max-tokens': '预检输出被截断',
        preflight_refusal: '预检被拒绝',
        preflight_disabled: '预检已关闭',
      },
      en: {
        insufficient_context: 'not enough context',
        preflight_unavailable: 'preflight unavailable',
        preflight_timeout: 'preflight timed out',
        preflight_invalid_json: 'unreadable preflight answer',
        preflight_aborted: 'preflight aborted',
        preflight_error: 'preflight failed',
        preflight_max_tokens: 'preflight answer truncated',
        'preflight_max-tokens': 'preflight answer truncated',
        preflight_refusal: 'preflight refused',
        preflight_disabled: 'preflight disabled',
      },
    }

    function formatFactor(factor) {
      if (typeof factor !== 'number' || !Number.isFinite(factor)) return '1'
      return factor.toFixed(2).replace(/0+$/u, '').replace(/\.$/u, '')
    }

    function languageOf(settings) {
      return settings !== null && settings !== undefined && settings.analysisLanguage === 'en' ? 'en' : 'zh'
    }

    function complexityText(complexity, language) {
      const table = language === 'en' ? COMPLEXITY_LABEL_EN : COMPLEXITY_LABEL
      return table[complexity] ?? table.unknown
    }

    function riskText(flags, language) {
      const table = RISK_LABEL[language]
      const separator = language === 'en' ? ', ' : '、'
      return flags.map(flag => table[flag] ?? String(flag)).join(separator)
    }

    // ---------------------------------------------------------------------
    // Shared client state
    // ---------------------------------------------------------------------

    function createStore(initial) {
      let value = initial
      const listeners = new Set()
      return {
        get: () => value,
        set(next) {
          value = next
          for (const listener of listeners) listener(value)
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      }
    }

    const etaStore = createStore(null)
    const completionStore = createStore(null)
    const settingsStore = createStore(null)
    const notifierStore = createStore([])
    const calibrationStore = createStore({})

    let stream = null
    let streamSession = null

    function connectStream(sessionId) {
      if (typeof EventSource === 'undefined') return
      if (stream !== null && streamSession === sessionId) return
      if (stream !== null) {
        stream.close()
        stream = null
      }
      streamSession = sessionId
      const source = new EventSource(`${API.events}?sessionId=${encodeURIComponent(sessionId)}`)
      stream = source
      source.addEventListener('state', event => {
        try {
          etaStore.set(JSON.parse(event.data))
        } catch {
          // A malformed frame only loses one tick.
        }
      })
      source.addEventListener('settings', event => {
        try {
          settingsStore.set(JSON.parse(event.data))
        } catch {
          // Ignore.
        }
      })
      source.addEventListener('completed', event => {
        try {
          completionStore.set(JSON.parse(event.data))
        } catch {
          // Ignore.
        }
      })
      source.addEventListener('error', () => {
        // EventSource reconnects on its own; nothing to do here.
      })
    }

    async function postJson(url, body) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify(body ?? {}),
      })
      const text = await response.text()
      let parsed = null
      try {
        parsed = text === '' ? null : JSON.parse(text)
      } catch {
        parsed = null
      }
      return { status: response.status, body: parsed }
    }

    // ---------------------------------------------------------------------
    // Ring tones
    // ---------------------------------------------------------------------

    const SYNTH = {
      success: { notes: [523.25, 659.25, 783.99], type: 'sine', step: 0.09, length: 0.16 },
      chime: { notes: [880, 1174.66], type: 'sine', step: 0.18, length: 0.6 },
      bell: { notes: [1046.5, 1567.98, 2093], type: 'triangle', step: 0.02, length: 1.1 },
      pop: { notes: [320], type: 'square', step: 0, length: 0.12 },
    }

    const player = {
      context: null,
      unlocked: false,
      ensure() {
        if (this.context === null) {
          const Ctor = window.AudioContext || window.webkitAudioContext
          if (typeof Ctor !== 'function') return null
          this.context = new Ctor()
        }
        return this.context
      },
      async unlock() {
        const context = this.ensure()
        if (context === null) return false
        try {
          if (context.state === 'suspended') await context.resume()
          // A silent tick is what actually unlocks playback on some engines.
          const buffer = context.createBuffer(1, 1, 22050)
          const source = context.createBufferSource()
          source.buffer = buffer
          source.connect(context.destination)
          source.start(0)
          this.unlocked = context.state === 'running'
        } catch {
          this.unlocked = false
        }
        return this.unlocked
      },
      async play(settings) {
        const volume = typeof settings.volume === 'number' ? settings.volume : 0.7
        if (volume <= 0) return
        if (settings.ringtone === 'custom' && typeof settings.customRingtoneUrl === 'string' && settings.customRingtoneUrl !== '') {
          const audio = new Audio(settings.customRingtoneUrl)
          audio.volume = volume
          try {
            await audio.play()
            return
          } catch {
            // Fall through to the built-in ding when the custom tone cannot play.
          }
        }
        if (settings.ringtone === 'ding') {
          const audio = new Audio(API.ding)
          audio.volume = volume
          try {
            await audio.play()
            return
          } catch {
            // Fall back to a synthesized ding below.
          }
        }
        const spec = SYNTH[settings.ringtone] ?? SYNTH.chime
        const context = this.ensure()
        if (context === null) return
        if (context.state === 'suspended') {
          try {
            await context.resume()
          } catch {
            return
          }
        }
        const now = context.currentTime
        for (let index = 0; index < spec.notes.length; index += 1) {
          const oscillator = context.createOscillator()
          const gain = context.createGain()
          oscillator.type = spec.type
          oscillator.frequency.value = spec.notes[index]
          const start = now + index * spec.step
          gain.gain.setValueAtTime(0.0001, start)
          gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, volume * 0.6), start + 0.01)
          gain.gain.exponentialRampToValueAtTime(0.0001, start + spec.length)
          oscillator.connect(gain)
          gain.connect(context.destination)
          oscillator.start(start)
          oscillator.stop(start + spec.length + 0.02)
        }
      },
    }

    function notifyCompletion(payload) {
      if (typeof Notification !== 'function') return
      if (Notification.permission !== 'granted') return
      try {
        const spent = minutesText((payload.elapsedMs ?? 0) / 60_000) ?? '0 秒'
        new Notification('DSH · 会话完成', {
          body: `${payload.title ?? payload.sessionId ?? ''} · 用时 ${spent}`,
          tag: `preflight-eta-chime:${payload.sessionId ?? ''}`,
        })
      } catch {
        // A blocked constructor must not break the page.
      }
    }

    // ---------------------------------------------------------------------
    // Formatting
    // ---------------------------------------------------------------------

    function minutesText(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return null
      if (value < 1 / 60) return '0 秒'
      if (value < 1) return `${Math.max(1, Math.round(value * 60))} 秒`
      return `${Math.round(value)} 分钟`
    }

    function rangeText(view) {
      const p50 = view.minutesP50
      const p90 = view.minutesP90
      if (typeof p50 !== 'number' && typeof p90 !== 'number') return null
      // Sub-minute turns are the common case now that the preflight estimates one
      // answer rather than a whole task, so the band reads in seconds there.
      if (typeof p90 === 'number' && p90 < 1) return `约 ${Math.max(5, Math.round(p90 * 60))} 秒`
      if (typeof p50 === 'number' && p50 < 1) return '1 分钟以内'
      if (typeof p50 === 'number' && typeof p90 === 'number' && p90 > p50) {
        return `${Math.floor(p50)}–${Math.ceil(p90)} 分钟`
      }
      return minutesText(p50 ?? p90)
    }

    function useStore(store) {
      const [value, setValue] = useState(store.get())
      useEffect(() => store.subscribe(setValue), [store])
      return value
    }

    // ---------------------------------------------------------------------
    // ETA pill
    // ---------------------------------------------------------------------

    const pillStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px',
      padding: '2px 10px',
      borderRadius: '999px',
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-l2)',
      color: 'var(--dsw-alias-text-l2)',
      fontSize: '12px',
      lineHeight: '20px',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    }

    const popoverStyle = {
      position: 'absolute',
      bottom: 'calc(100% + 8px)',
      left: 0,
      zIndex: 40,
      minWidth: '220px',
      padding: '10px 12px',
      borderRadius: '10px',
      border: '1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12))',
      // Opaque on purpose: the composer sits over a translucent page surface, and
      // a translucent card let the text behind it bleed through. `card-fill` is a
      // solid palette entry (neutral-50 light, neutral-850 dark), unlike bg-l1/l2
      // which are layered translucent surfaces.
      background: 'var(--dsw-alias-card-fill, #ffffff)',
      boxShadow: '0 6px 24px rgba(0, 0, 0, 0.18)',
      color: 'var(--dsw-alias-label-primary, #1a1a1a)',
      fontSize: '12px',
      lineHeight: '18px',
    }

    const SOURCE_LABEL = {
      preflight: 'sourcePreflight',
      evidence: 'sourceEvidence',
      history: 'sourceHistory',
      coarse: 'sourceCoarse',
    }

    function EtaPill(props) {
      const sessionId = props.sessionId
      const t = props.t ?? (key => key)
      const settings = useStore(settingsStore)
      const view = useStore(etaStore)
      const [open, setOpen] = useState(false)
      const [settingsOpen, setSettingsOpen] = useState(false)

      useEffect(() => {
        if (typeof sessionId === 'string' && sessionId !== '') connectStream(sessionId)
      }, [sessionId])

      useEffect(() => {
        if (settings === null) void loadSettings()
      }, [settings])

      const enabled = settings === null ? true : settings.etaEnabled !== false
      if (!enabled) return null
      const language = languageOf(settings)

      let text = t('etaNone')
      let tone = 'var(--dsw-alias-text-l2)'
      if (view !== null && view.state === 'running') {
        const elapsed = minutesText((view.elapsedMs ?? 0) / 60_000) ?? '0 分钟'
        const left = rangeText(view)
        text = left === null ? `已用 ${elapsed}` : t('etaRunning').replace('{elapsed}', elapsed).replace('{left}', left)
        tone = 'var(--dsw-alias-text-l1)'
      } else if (view !== null && view.state === 'finished') {
        text = t('etaFinished').replace('{elapsed}', minutesText((view.elapsedMs ?? 0) / 60_000) ?? '0 分钟')
      } else if (view !== null && rangeText(view) !== null) {
        const complexity = complexityText(view.complexity, language)
        text = t('etaPlanned').replace('{range}', rangeText(view)).replace('{complexity}', complexity)
      } else if (view === null) {
        text = t('etaNone')
      }

      const details = []
      if (view !== null) {
        details.push(`${t('complexity')}: ${complexityText(view.complexity, language)}`)
        if (view.stepsDone !== undefined) details.push(`${t('steps')}: ${view.stepsDone}`)
        const sourceLabel = SOURCE_LABEL[view.source]
        if (sourceLabel !== undefined) {
          const line = `${t('basisLabel')}: ${t(sourceLabel)}`
          details.push(view.basis ? `${line} · ${view.basis}` : line)
        }
        if (view.preflightDegraded) details.push(t('etaDegraded'))
        if (Array.isArray(view.riskFlags) && view.riskFlags.length > 0) {
          details.push(`${t('riskFlags')}: ${riskText(view.riskFlags, language)}`)
        }
      }

      return h(
        'span',
        { style: { position: 'relative', display: 'inline-block' } },
        h(
          'button',
          {
            type: 'button',
            style: { ...pillStyle, color: tone },
            title: text,
            onClick: () => setOpen(value => !value),
          },
          h('span', { 'aria-hidden': true, style: { opacity: 0.7 } }, '⏱'),
          h('span', null, text),
        ),
        open
          ? h(
              'div',
              { style: popoverStyle },
              details.length === 0
                ? h('div', null, t('etaNone'))
                : details.map((line, index) => h('div', { key: `${index}` }, line)),
              h(
                'div',
                { style: { marginTop: '8px', display: 'flex', justifyContent: 'flex-end' } },
                h(
                  'button',
                  {
                    type: 'button',
                    style: { cursor: 'pointer', fontSize: '12px' },
                    onClick: () => {
                      setOpen(false)
                      setSettingsOpen(true)
                    },
                  },
                  t('openSettings'),
                ),
              ),
            )
          : null,
        settingsOpen ? h(SettingsDialog, { t, onClose: () => setSettingsOpen(false) }) : null,
      )
    }

    // ---------------------------------------------------------------------
    // Preflight button + card
    // ---------------------------------------------------------------------

    function PreflightButton(props) {
      const sessionId = props.sessionId
      const t = props.t ?? (key => key)
      const [state, setState] = useState({ status: 'idle', result: null, eta: null, signals: null })
      const settings = useStore(settingsStore)
      const busyRef = useRef(false)

      const run = useCallback(async () => {
        if (busyRef.current || typeof sessionId !== 'string' || sessionId === '') return
        busyRef.current = true
        setState({ status: 'running', result: null, eta: null, signals: null })
        try {
          const reply = await postJson(API.estimate, { sessionId })
          if (reply.status === 200 && reply.body !== null) {
            setState({
              status: 'done',
              result: reply.body.result ?? null,
              eta: reply.body.eta ?? null,
              signals: reply.body.signals ?? null,
            })
            if (reply.body.eta !== undefined) etaStore.set(reply.body.eta)
          } else {
            setState({
              status: 'done',
              result: { ok: false, degraded: true, riskFlags: [reply.body?.error ?? 'preflight_unavailable'] },
              eta: null,
              signals: null,
            })
          }
        } catch {
          setState({
            status: 'done',
            result: { ok: false, degraded: true, riskFlags: ['preflight_unavailable'] },
            eta: null,
            signals: null,
          })
        } finally {
          busyRef.current = false
        }
      }, [sessionId])

      useEffect(() => {
        function onKeyDown(event) {
          if (event.ctrlKey && event.shiftKey && (event.key === 'Enter' || event.code === 'Enter')) {
            event.preventDefault()
            void run()
          }
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [run])

      const result = state.result
      // While the turn runs the pill counts down, so the card reads the same live
      // view instead of freezing on the estimate it was opened with.
      const eta = useStore(etaStore)
      const live = eta !== null && eta.state === 'running' && typeof eta.minutesP50 === 'number' ? eta : null
      const done = eta !== null && eta.state === 'finished'
      const language = languageOf(settings)
      const degraded = result !== null && (result.ok !== true || result.degraded === true)
      const card = state.status === 'done'
        ? h(
            'div',
            { style: { ...popoverStyle, position: 'absolute', bottom: 'calc(100% + 8px)', left: 0 } },
            h(
              'div',
              { style: { fontWeight: 600, marginBottom: '4px', display: 'flex', gap: '6px', alignItems: 'baseline' } },
              t('preflightEstimate'),
              result !== null && result.cached
                ? h('span', { style: { fontSize: '11px', opacity: 0.6, fontWeight: 400 } }, t('cachedBadge'))
                : null,
            ),
            result === null
              ? h('div', null, t('preflightUnavailable'))
              : degraded
                ? h(
                    'div',
                    null,
                    h('div', null, t('preflightUnavailable')),
                    result.riskFlags && result.riskFlags.length > 0
                      ? h('div', { style: { opacity: 0.75 } }, `${t('riskFlags')}: ${riskText(result.riskFlags, language)}`)
                      : null,
                  )
                : h(
                    'div',
                    null,
                    h('div', null, `${t('complexity')}: ${complexityText(result.complexity, language)}`),
                    h('div', null, `${live !== null ? `${t('preflightRemaining')}: ${rangeText(live) ?? '—'}` : rangeText(result) ?? '—'}`),
                    live === null
                      ? null
                      : h('div', { style: { opacity: 0.6 } }, `${t('preflightInitial')}: ${rangeText(result) ?? '—'}`),
                    done
                      ? h('div', { style: { opacity: 0.75 } }, t('etaFinished').replace('{elapsed}', minutesText((eta.elapsedMs ?? 0) / 60_000) ?? '0 分钟'))
                      : null,
                    result.basis
                      ? h('div', { style: { opacity: 0.75 } }, `${t('basisLabel')}: ${result.basis}`)
                      : null,
                    state.signals
                      ? h('div', { style: { opacity: 0.6 } }, `${t('signalsLabel')}: ${state.signals}`)
                      : null,
                    result.calibration
                      ? h(
                          'div',
                          { style: { opacity: 0.75 } },
                          t('calibrationApplied')
                            .replace('{factor}', formatFactor(result.calibration.factor))
                            .replace('{samples}', String(result.calibration.samples)),
                        )
                      : null,
                    result.riskFlags && result.riskFlags.length > 0
                      ? h('div', null, `${t('riskFlags')}: ${riskText(result.riskFlags, language)}`)
                      : null,
                  ),
            h(
              'button',
              {
                type: 'button',
                style: { marginTop: '6px', fontSize: '12px', cursor: 'pointer' },
                onClick: () => setState({ status: 'idle', result: null, eta: null, signals: null }),
              },
              '×',
            ),
          )
        : null

      return h(
        'span',
        { style: { position: 'relative', display: 'inline-block' } },
        h(
          'button',
          {
            type: 'button',
            style: { ...pillStyle, cursor: 'pointer' },
            disabled: state.status === 'running',
            onClick: () => void run(),
            title: 'Ctrl+Shift+Enter',
          },
          state.status === 'running' ? t('preflightRunning') : t('preflight'),
        ),
        card,
      )
    }

    // ---------------------------------------------------------------------
    // Settings
    // ---------------------------------------------------------------------

    async function loadSettings() {
      try {
        const response = await fetch(API.settings, { cache: 'no-store' })
        const body = await response.json()
        if (body && body.settings) settingsStore.set(body.settings)
        if (body && Array.isArray(body.notifiers)) notifierStore.set(body.notifiers)
        if (body && typeof body.calibration === 'object' && body.calibration !== null) calibrationStore.set(body.calibration)
        return body
      } catch {
        return null
      }
    }

    const fieldStyle = { display: 'flex', alignItems: 'center', gap: '8px', margin: '6px 0', fontSize: '13px' }
    const inputStyle = {
      flex: '1 1 auto',
      minWidth: 0,
      padding: '3px 6px',
      borderRadius: '6px',
      border: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-l1)',
      color: 'var(--dsw-alias-text-l1)',
    }

    function SettingsPanel(props) {
      const form = props.form
      const t = props.t ?? (key => key)
      const notifiers = useStore(notifierStore)
      const buckets = useStore(calibrationStore)
      const learned = Object.keys(buckets ?? {}).reduce(
        (total, key) => total + (Number(buckets[key]?.samples) || 0),
        0,
      )
      const [settings, setSettings] = useState(null)
      const [status, setStatus] = useState('')
      const [unlocked, setUnlocked] = useState(player.unlocked)

      useEffect(() => {
        void loadSettings().then(body => {
          if (body && body.settings) setSettings(body.settings)
        })
      }, [])

      const patch = useCallback(next => {
        setSettings(current => ({ ...(current ?? {}), ...next }))
        setStatus('')
      }, [])

      const save = useCallback(async () => {
        if (settings === null) return
        const reply = await postJson(API.settings, settings).catch(() => null)
        if (reply !== null && reply.body && reply.body.settings) {
          settingsStore.set(reply.body.settings)
          setStatus(t('saved'))
        }
      }, [settings, t])

      const preview = useCallback(async () => {
        if (settings === null) return
        await player.unlock()
        await player.play(settings)
        setUnlocked(player.unlocked)
      }, [settings])

      const chooseFile = useCallback(async event => {
        const file = event.target.files && event.target.files[0]
        if (!file) return
        if (file.size > 2 * 1024 * 1024) {
          setStatus('≤2MB')
          return
        }
        const reader = new FileReader()
        reader.onload = () => {
          if (typeof reader.result === 'string') patch({ ringtone: 'custom', customRingtoneUrl: reader.result })
        }
        reader.readAsDataURL(file)
      }, [patch])

      if (props.view === 'summary') {
        return h('span', null, t('settingsTitle'))
      }
      if (settings === null) return h('div', { style: { fontSize: '12px', opacity: 0.7 } }, '…')

      const row = (label, control) => h('label', { style: fieldStyle }, h('span', { style: { minWidth: '120px' } }, label), control)
      const checkbox = (key, label) =>
        row(
          label,
          h('input', {
            type: 'checkbox',
            checked: settings[key] !== false,
            onChange: event => patch({ [key]: event.target.checked }),
          }),
        )

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '2px', maxWidth: '520px' } },
        h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, t('settingsTitle')),
        checkbox('preflightEnabled', t('enablePreflight')),
        checkbox('etaEnabled', t('enableEta')),
        checkbox('chimeEnabled', t('enableChime')),
        row(
          t('ringtone'),
          h(
            'select',
            {
              style: { ...inputStyle, flex: '0 1 180px' },
              value: settings.ringtone ?? 'ding',
              onChange: event => patch({ ringtone: event.target.value }),
            },
            RINGTONES.map(tone => h('option', { key: tone.id, value: tone.id }, tone.label)),
          ),
        ),
        row(
          t('volume'),
          h('input', {
            type: 'range',
            min: 0,
            max: 1,
            step: 0.05,
            value: settings.volume ?? 0.7,
            onChange: event => patch({ volume: Number(event.target.value) }),
          }),
        ),
        row(
          t('analysisLanguage'),
          h(
            'select',
            {
              style: { ...inputStyle, flex: '0 1 180px' },
              value: settings.analysisLanguage ?? 'zh',
              onChange: event => patch({ analysisLanguage: event.target.value }),
            },
            h('option', { value: 'zh' }, '中文'),
            h('option', { value: 'en' }, 'English'),
          ),
        ),
        h('div', { style: { opacity: 0.65, fontSize: '11px', marginLeft: '120px', marginBottom: '4px' } }, t('analysisLanguageHint')),
        checkbox('chimeRespectNotifiers', t('respectNotifiers')),
        h('div', { style: { opacity: 0.65, fontSize: '11px', marginLeft: '120px', marginBottom: '4px' } }, t('respectNotifiersHint')),
        checkbox('learnFromTurns', t('learnFromTurns')),
        h('div', { style: { opacity: 0.65, fontSize: '11px', marginLeft: '120px', marginBottom: '4px' } }, t('learnHint')),
        learned > 0
          ? h('div', { style: { opacity: 0.75, fontSize: '11px', marginLeft: '120px', marginBottom: '4px' } }, t('learnedSamples').replace('{count}', String(learned)))
          : null,
        notifiers.length > 0
          ? h('div', { style: { opacity: 0.75, fontSize: '11px', marginLeft: '120px', marginBottom: '4px' } }, t('notifiersDetected').replace('{list}', notifiers.join(', ')))
          : null,
        settings.ringtone === 'custom'
          ? row(
              t('customSource'),
              h('input', {
                style: inputStyle,
                value: settings.customRingtoneUrl ?? '',
                placeholder: 'https://… or D:\\sounds\\ding.wav',
                onChange: event => patch({ customRingtoneUrl: event.target.value }),
              }),
            )
          : null,
        row('', h('input', { type: 'file', accept: 'audio/*', onChange: event => void chooseFile(event) })),
        h(
          'div',
          { style: { display: 'flex', gap: '8px', marginTop: '8px', flexWrap: 'wrap' } },
          h('button', { type: 'button', style: { cursor: 'pointer' }, onClick: () => void preview() }, t('preview')),
          h(
            'button',
            {
              type: 'button',
              style: { cursor: 'pointer' },
              onClick: async () => {
                const ok = await player.unlock()
                setUnlocked(ok)
                if (ok && typeof Notification === 'function' && Notification.permission === 'default') {
                  try {
                    await Notification.requestPermission()
                  } catch {
                    // Denied stays denied.
                  }
                }
              },
            },
            unlocked ? t('unlocked') : t('unlockAudio'),
          ),
          h('button', { type: 'button', style: { cursor: 'pointer' }, onClick: () => void save() }, t('save')),
          status === '' ? null : h('span', { style: { fontSize: '12px', opacity: 0.75 } }, status),
        ),
      )
    }

    // ---------------------------------------------------------------------
    // Settings dialog
    // ---------------------------------------------------------------------
    //
    // The Plugins page of the Host is versioned: a build that hides its
    // settings shell never declares `plugins.row.config`, so a registration
    // there can go unseen. This dialog keeps one settings entry point on the
    // composer itself, where the plugin's own pill always renders.

    const dialogOverlayStyle = {
      position: 'fixed',
      inset: 0,
      zIndex: 2147483000,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '24px',
      background: 'rgba(0, 0, 0, 0.35)',
    }

    const dialogPanelStyle = {
      background: 'var(--dsw-alias-card-fill, #ffffff)',
      color: 'var(--dsw-alias-label-primary, #1a1a1a)',
      borderRadius: '10px',
      border: '1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12))',
      boxShadow: '0 18px 48px rgba(0, 0, 0, 0.28)',
      padding: '16px',
      maxWidth: '560px',
      width: '100%',
      maxHeight: '80vh',
      overflow: 'auto',
      fontSize: '13px',
    }

    function SettingsDialog(props) {
      const t = props.t ?? (key => key)
      const onClose = props.onClose
      useEffect(() => {
        const onKey = event => {
          if (event.key === 'Escape') onClose()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose])
      return h(
        'div',
        { style: dialogOverlayStyle, onClick: () => onClose() },
        h(
          'div',
          { style: dialogPanelStyle, onClick: event => event.stopPropagation() },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' } },
            h('strong', null, t('settingsTitle')),
            h('button', { type: 'button', style: { cursor: 'pointer' }, onClick: () => onClose() }, t('close')),
          ),
          h(SettingsPanel, { t }),
        ),
      )
    }

    // ---------------------------------------------------------------------
    // Completion watcher (one per page, mounted once)
    // ---------------------------------------------------------------------

    function CompletionWatcher() {
      const completion = useStore(completionStore)
      useEffect(() => {
        if (completion === null) return
        void (async () => {
          if (typeof Notification === 'function' && Notification.permission === 'default') {
            try {
              await Notification.requestPermission()
            } catch {
              // Ignore.
            }
          }
          if (completion.chime !== false) {
            const settings = settingsStore.get() ?? { ringtone: 'ding', volume: 0.7 }
            await player.play(settings)
          }
          notifyCompletion(completion)
        })()
      }, [completion])
      return null
    }

    function OverlaySlot() {
      return h(CompletionWatcher)
    }

    // ---------------------------------------------------------------------
    // Plugin object
    // ---------------------------------------------------------------------

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => {
          const disposers = [ctx.locale.register(NS, 'en', STRINGS.en), ctx.locale.register(NS, 'zh', STRINGS.zh)]
          return () => disposers.forEach(dispose => typeof dispose === 'function' && dispose())
        }, 'preflight-eta-chime: strings')
        void loadSettings()

        // Browsers only unlock audio from a user gesture; the first click anywhere
        // is a good enough moment to prepare playback.
        const unlockOnGesture = () => {
          window.removeEventListener('pointerdown', unlockOnGesture, true)
          void player.unlock()
        }
        window.addEventListener('pointerdown', unlockOnGesture, true)
        ctx.effect(() => () => window.removeEventListener('pointerdown', unlockOnGesture, true), 'preflight-eta-chime: audio unlock listener')

        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register({ name: 'conversation.composer.dock', id: 'eta', order: 30, locale: NS }, EtaPill),
        )
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register({ name: 'conversation.composer.dock', id: 'preflight', order: 31, locale: NS }, PreflightButton),
        )
        ctx.slots.inject('plugins.row.config', () =>
          ctx.slots.register({ name: 'plugins.row.config', key: ROW_KEY, locale: NS }, SettingsPanel),
        )
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'preflight-eta-chime', order: 90 }, OverlaySlot),
        )
      },
    }
  },
})

/**
 * 快速重启插件 —— Client 侧
 *
 * 两个常驻图标：会话标题栏右侧操作区的刷新按钮（圆形箭头）与重启按钮（电源符号）。
 * 点击 POST 本机路由 /plugin-http/dsh-quick-restart，由 Host 通过 WMI 起一个
 * 无窗口的 helper，关闭桌面应用并用原命令行重新打开（Host 插件改动随即生效）。
 *
 * 没有构建步骤：本文件由 Client 模块加载器直接执行，只依赖共享模块表里的 react。
 */

window.__ModuleLoader__.load({
  id: '@iridensity_gray/dsh-quick-restart',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-quick-restart'
    const ROUTE = '/plugin-http/dsh-quick-restart'
    const HEADER_SLOT = 'conversation.session.header.utilities'
    /** How often the Client asks the Host what happened to a restart request. */
    const STATUS_POLL_MS = 1_500
    /** Give up following a restart the helper never confirmed (wording stays honest). */
    const REQUEST_TIMEOUT_MS = 90_000
    /** How long a failure notice stays before it can be dismissed away. */
    const ERROR_TOAST_MS = 30_000
    /** Styles for states inline styles cannot express (:focus-visible / the spin). */
    const CSS_ID = 'dsh-quick-restart-style'

    const DICTIONARIES = {
      zh: {
        'action.restart.aria': '重启 DeepSeek Harness',
        'action.restart.title': '重启 DeepSeek Harness：关闭应用并自动重新打开（会中断正在运行的对话）',
        'action.restart.busy': '正在重启 DeepSeek Harness',
        'toast.restarting.title': '正在重启 DeepSeek Harness…',
        'toast.restarting.body': '窗口会关闭并自动重新打开。正在运行的对话会被中断。',
        'toast.unconfirmed.title': '重启请求没有确认',
        'toast.unconfirmed.body': '重启脚本没有回应，应用可能没有重启。可以再点一次电源按钮重试。',
        'toast.failed.title': '重启失败',
        'toast.failed.generic': '重启脚本没有启动，详情见下方日志。',
        'error.unsupported-platform': '重启只支持 Windows 桌面版。',
        'error.not-desktop': '当前 Host 不在桌面应用中运行，无法重启应用。',
        'error.executable-unknown': '找不到桌面应用的可执行文件。',
        'error.executable-missing': '桌面应用的可执行文件不存在。',
        'error.helper-missing': '插件缺少重启脚本 restart.ps1。',
        'error.process-unknown': '无法定位桌面应用进程。',
        'error.launch-failed': '无法启动重启脚本。',
        'error.helper-failed': '重启脚本中止了，应用可能没有重新打开。',
        'toast.dismiss': '关闭',
      },
      en: {
        'action.restart.aria': 'Restart DeepSeek Harness',
        'action.restart.title': 'Restart DeepSeek Harness: close and reopen the app (interrupts a running conversation)',
        'action.restart.busy': 'Restarting DeepSeek Harness',
        'toast.restarting.title': 'Restarting DeepSeek Harness…',
        'toast.restarting.body': 'The window will close and reopen automatically. A running conversation is interrupted.',
        'toast.unconfirmed.title': 'The restart was not confirmed',
        'toast.unconfirmed.body': 'The restart helper did not answer, so the app may still be running. Press the power button again to retry.',
        'toast.failed.title': 'Restart failed',
        'toast.failed.generic': 'The restart helper did not start; see the log below.',
        'error.unsupported-platform': 'Restart works only in the Windows desktop app.',
        'error.not-desktop': 'This Host does not run inside the desktop app, so the app cannot be restarted.',
        'error.executable-unknown': 'The desktop executable could not be found.',
        'error.executable-missing': 'The desktop executable is missing.',
        'error.helper-missing': 'The plugin is missing restart.ps1.',
        'error.process-unknown': 'The desktop process could not be identified.',
        'error.launch-failed': 'The restart helper could not be started.',
        'error.helper-failed': 'The restart helper stopped, so the app may not have reopened.',
        'toast.dismiss': 'Dismiss',
      },
    }

    /** Snapshot store: one immutable value with plain listeners. */
    function createStore (initial) {
      let value = initial
      const listeners = new Set()
      return {
        getSnapshot: () => value,
        subscribe (listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        set (next) {
          if (value === next) return
          value = next
          for (const listener of [...listeners]) listener()
        },
      }
    }

    function useSnapshot (store) {
      return React.useSyncExternalStore
        ? React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
        : store.getSnapshot()
    }

    const CSS_TEXT = `
.dshQuickRestart:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary));
  outline-offset: -2px;
}
.dshQuickRestart[aria-busy='true'] .dshQuickRestartGlyph {
  animation: dsh-quick-restart-spin 900ms linear infinite;
}
@keyframes dsh-quick-restart-spin {
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .dshQuickRestart[aria-busy='true'] .dshQuickRestartGlyph {
    animation: none;
  }
}
`

    function installStyles () {
      if (document.getElementById(CSS_ID) !== null) return () => {}
      const element = document.createElement('style')
      element.id = CSS_ID
      element.textContent = CSS_TEXT
      document.head.append(element)
      return () => { element.remove() }
    }

    /* ------------------------------------------------------------------ */
    /* Power glyph                                                         */
    /* ------------------------------------------------------------------ */

    /**
     * Power symbol: an unclosed circle (the arc leaves a gap at the top) with a
     * short vertical line through that gap. Drawn with round caps so the opening
     * stays visible at 15px.
     */
    function PowerIcon ({ size }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        'aria-hidden': true,
        className: 'dshQuickRestartGlyph',
      },
      h('path', { d: 'M18.36 6.64a9 9 0 1 1-12.73 0' }),
      h('line', { x1: 12, y1: 2.5, x2: 12, y2: 12 }))
    }

    /** Circular refresh arrow for "reload this page". */
    function ReloadIcon ({ size }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'currentColor',
        'aria-hidden': true,
        className: 'dshQuickRestartGlyph',
      }, h('path', {
        d: 'M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z',
      }))
    }

    /* ------------------------------------------------------------------ */
    /* Session header controls                                             */
    /* ------------------------------------------------------------------ */

    /** Shared 28px round icon-button chrome of the header's right-side utilities. */
    function HeaderIconButton ({ label, title, onClick, extra, Icon, size }) {
      const [hot, setHot] = React.useState(false)
      return h('button', {
        type: 'button',
        className: 'dshQuickRestart',
        'aria-label': label,
        title,
        onClick,
        ...extra,
        onMouseEnter: () => setHot(true),
        onMouseLeave: () => setHot(false),
        onFocus: () => setHot(true),
        onBlur: () => setHot(false),
        style: {
          display: 'inline-flex',
          flex: 'none',
          alignItems: 'center',
          justifyContent: 'center',
          width: 28,
          height: 28,
          padding: 0,
          border: 0,
          borderRadius: 28,
          background: hot ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
          color: hot ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
          cursor: 'pointer',
          transition: 'background-color 120ms ease, color 120ms ease',
        },
      }, h(Icon, { size }))
    }

    /** Header reload control: refreshes the page so Client plugin changes apply. */
    function ReloadButton ({ t }) {
      const translate = typeof t === 'function' ? t : key => key
      return h(HeaderIconButton, {
        label: translate('action.refresh.aria'),
        title: translate('action.refresh.title'),
        onClick: () => { window.location.reload() },
        extra: { 'data-dsh-quick-reload': '' },
        Icon: ReloadIcon,
        size: 15,
      })
    }

    /**
     * Header restart control: power glyph (unclosed circle, short vertical line)
     * in the header's own ink, beside the reload arrow.
     */
    function RestartButton ({ t, state, onRestart }) {
      const snapshot = useSnapshot(state)
      const busy = snapshot.phase === 'sending' || snapshot.phase === 'requested'
      const translate = typeof t === 'function' ? t : key => key
      return h(HeaderIconButton, {
        label: translate(busy ? 'action.restart.busy' : 'action.restart.aria'),
        title: translate('action.restart.title'),
        onClick: () => { onRestart() },
        extra: {
          'data-dsh-quick-restart': snapshot.phase,
          'aria-busy': busy ? 'true' : undefined,
          disabled: busy,
        },
        Icon: PowerIcon,
        size: 15,
      })
    }

    /* ------------------------------------------------------------------ */
    /* Restart feedback                                                    */
    /* ------------------------------------------------------------------ */

    /** Bottom-right notice: restart in flight, unconfirmed timeout, or failure. */
    function RestartToast ({ t, state, onDismiss }) {
      const snapshot = useSnapshot(state)
      const translate = typeof t === 'function' ? t : key => key
      const phase = snapshot.phase
      React.useEffect(() => {
        if (phase !== 'unconfirmed' && phase !== 'error') return undefined
        const timer = setTimeout(onDismiss, ERROR_TOAST_MS)
        return () => { clearTimeout(timer) }
      }, [snapshot.at, phase, onDismiss])
      const failed = phase === 'error'
      const dismissable = failed || phase === 'unconfirmed'
      if (phase !== 'requested' && !dismissable) return null
      const toneColor = failed
        ? 'var(--dsw-alias-state-error-primary)'
        : phase === 'requested'
          ? 'var(--dsw-alias-label-secondary)'
          : 'var(--dsw-alias-state-warn-primary)'
      const title = failed
        ? translate('toast.failed.title')
        : phase === 'unconfirmed'
          ? translate('toast.unconfirmed.title')
          : translate('toast.restarting.title')
      let body = ''
      if (failed) {
        const code = typeof snapshot.code === 'string' ? snapshot.code : ''
        body = code === '' ? '' : translate('error.' + code)
        if (body === 'error.' + code) body = snapshot.message === '' ? translate('toast.failed.generic') : snapshot.message
      } else if (phase === 'unconfirmed') {
        body = translate('toast.unconfirmed.body')
      } else {
        body = translate('toast.restarting.body')
      }
      const showLog = failed && typeof snapshot.logDir === 'string' && snapshot.logDir !== ''
      return h('div', {
        role: failed ? 'alert' : 'status',
        'aria-live': failed ? 'assertive' : 'polite',
        style: {
          position: 'absolute',
          right: 16,
          bottom: 16,
          width: 350,
          maxWidth: 'calc(100vw - 32px)',
          boxSizing: 'border-box',
          display: 'flex',
          alignItems: 'flex-start',
          gap: 10,
          padding: '12px 14px',
          borderRadius: 12,
          border: '1px solid var(--dsw-alias-border-l1)',
          background: 'var(--dsw-alias-bg-overlay)',
          color: 'var(--dsw-alias-label-primary)',
          boxShadow: '0 12px 32px rgba(0, 0, 0, 0.22)',
          pointerEvents: 'auto',
        },
      },
      h('span', {
        'aria-hidden': true,
        style: { flex: 'none', width: 8, height: 8, marginTop: 6, borderRadius: 4, background: toneColor },
      }),
      h('div', { style: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 } },
        h('div', { style: { fontSize: 13, fontWeight: 600, lineHeight: '18px', color: failed ? toneColor : 'var(--dsw-alias-label-primary)' } }, title),
        h('div', {
          style: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)', wordBreak: 'break-word' },
        }, body),
        showLog ? h('div', {
          style: {
            marginTop: 2, fontSize: 11.5, lineHeight: '16px', color: 'var(--dsw-alias-label-secondary)',
            fontFamily: 'var(--ds-font-family-code, ui-monospace, monospace)', wordBreak: 'break-all',
            userSelect: 'text',
          },
        }, snapshot.logDir) : null),
      dismissable ? h('button', {
        type: 'button',
        className: 'dshQuickRestart',
        'aria-label': translate('toast.dismiss'),
        title: translate('toast.dismiss'),
        onClick: onDismiss,
        style: {
          flex: 'none', width: 24, height: 24, marginLeft: 2, padding: 0, border: 'none', borderRadius: 6,
          background: 'transparent', color: 'var(--dsw-alias-label-secondary)',
          cursor: 'pointer', fontSize: 15, lineHeight: '16px',
        },
      }, '\u00d7') : null)
    }

    /* ------------------------------------------------------------------ */
    /* Plugin body                                                         */
    /* ------------------------------------------------------------------ */

    const inject = ['slots', 'locale']

    function apply (ctx) {
      /** idle | sending | requested | unconfirmed | error */
      const state = createStore({ phase: 'idle', message: '', code: '', logDir: '', at: 0 })
      let inFlight = false

      ctx.effect(installStyles, 'quick-restart: styles')
      ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'quick-restart: dictionaries')

      const reset = () => {
        state.set({ phase: 'idle', message: '', code: '', logDir: '', at: 0 })
      }

      const post = async (body) => {
        const response = await fetch(ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(body),
        })
        let payload = null
        try { payload = await response.json() } catch { payload = null }
        return { ok: response.ok, payload }
      }

      /**
       * Ask the Host what happened to the remembered restart request, so a helper
       * that never confirmed becomes a visible failure instead of a stalled
       * "restarting". A failed read only means the window went away with the old
       * instance; success announces itself by closing the app.
       */
      const followUp = async () => {
        const deadline = Date.now() + REQUEST_TIMEOUT_MS
        while (Date.now() < deadline) {
          await new Promise((resolve) => { setTimeout(resolve, STATUS_POLL_MS) })
          try {
            const { ok, payload } = await post({ action: 'status' })
            if (!ok || payload === null || payload.ok !== true) continue
            if (payload.data.phase === 'failed') {
              state.set({
                phase: 'error', message: String(payload.data.detail ?? ''), code: String(payload.data.code ?? ''),
                logDir: '', at: Date.now(),
              })
              return
            }
            if (payload.data.phase === 'launched') return
          } catch {
            return
          }
        }
        state.set({ phase: 'unconfirmed', message: '', code: '', logDir: '', at: Date.now() })
      }

      const requestRestart = async () => {
        if (inFlight) return
        inFlight = true
        state.set({ phase: 'sending', message: '', code: '', logDir: '', at: Date.now() })
        try {
          const { ok, payload } = await post({ action: 'restart' })
          if (!ok || payload === null || payload.ok !== true) {
            state.set({
              phase: 'error',
              message: String(payload?.error ?? payload?.detail ?? ''),
              code: String(payload?.code ?? ''),
              logDir: '',
              at: Date.now(),
            })
            return
          }
          state.set({ phase: 'requested', message: '', code: '', logDir: '', at: Date.now() })
          inFlight = false
          await followUp()
        } catch (error) {
          const message = error !== null && typeof error === 'object' && typeof error.message === 'string'
            ? error.message
            : String(error)
          state.set({ phase: 'error', message, code: 'launch-failed', logDir: '', at: Date.now() })
        } finally {
          inFlight = false
        }
      }

      ctx.slots.inject(HEADER_SLOT, function* () {
        yield ctx.slots.register({
          name: HEADER_SLOT,
          id: 'dsh-quick-restart.restart',
          order: 0,
          locale: NS,
          inject: () => ({ state, onRestart: requestRestart }),
        }, RestartButton)
        yield ctx.slots.register({
          name: HEADER_SLOT,
          id: 'dsh-quick-restart.reload',
          order: 10,
          locale: NS,
        }, ReloadButton)
      })

      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'dsh-quick-restart.toast',
        order: 60,
        locale: NS,
        inject: () => ({ state, onDismiss: reset }),
      }, RestartToast))
    }

    return { inject, apply }
  },
})




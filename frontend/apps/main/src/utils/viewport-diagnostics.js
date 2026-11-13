const HISTORY_LIMIT = 24
const SAMPLE_INTERVAL = 150
const RECT_FIELDS = ['x', 'y', 'top', 'right', 'bottom', 'left', 'width', 'height']
const VIEWPORT_FIELDS = ['width', 'height', 'scale', 'offsetTop', 'offsetLeft', 'pageTop', 'pageLeft']
const STYLE_FIELDS = [
  'position', 'transform', 'overflowX', 'overflowY', 'width', 'height',
  'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'
]

const number = value => Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null
const numbers = (source, fields) => Object.fromEntries(fields.map(key => [key, number(source?.[key])]))

// Opt-in and memory-only. Capture geometry, never page text, URLs, account data,
// storage or arbitrary attributes. This observes layout without correcting it.
export function createViewportRecorder ({ win = window, version = '' } = {}) {
  const doc = win.document
  let active = false
  let report = null
  let startedAt = 0
  let probe = null
  let frame = null
  let sampleTimer = null
  let settleTimers = []
  let listeners = []
  let lastSample = -Infinity
  let lastVisible = null
  let hasBackgrounded = false

  const snapshot = reason => {
    const element = node => {
      if (!node) return null
      const style = win.getComputedStyle(node)
      return {
        rect: numbers(node.getBoundingClientRect(), RECT_FIELDS),
        style: Object.fromEntries(STYLE_FIELDS.map(key => [key, style[key]]))
      }
    }
    const focused = doc.activeElement
    const safeStyle = probe && win.getComputedStyle(probe)
    return {
      reason,
      elapsedMs: Math.round(win.performance.now() - startedAt),
      hidden: doc.hidden,
      standalone: win.navigator.standalone === true || win.matchMedia('(display-mode: standalone)').matches,
      pointer: win.matchMedia('(pointer: coarse)').matches ? 'coarse' :
        win.matchMedia('(pointer: fine)').matches ? 'fine' : 'none',
      screen: numbers(win.screen, ['width', 'height', 'availWidth', 'availHeight']),
      orientation: {
        type: win.screen.orientation?.type ?? null,
        angle: number(win.screen.orientation?.angle)
      },
      window: numbers(win, ['innerWidth', 'innerHeight', 'scrollX', 'scrollY', 'devicePixelRatio']),
      document: numbers(doc.documentElement, ['clientWidth', 'clientHeight', 'scrollWidth', 'scrollHeight']),
      visualViewport: win.visualViewport ? numbers(win.visualViewport, VIEWPORT_FIELDS) : null,
      elements: {
        html: element(doc.documentElement),
        body: element(doc.body),
        app: element(doc.getElementById('app')),
        shell: element(doc.querySelector('.app-shell'))
      },
      safeArea: safeStyle ? {
        top: safeStyle.paddingTop, right: safeStyle.paddingRight,
        bottom: safeStyle.paddingBottom, left: safeStyle.paddingLeft
      } : null,
      viewportHeight: win.getComputedStyle(doc.documentElement).getPropertyValue('--visual-viewport-height').trim(),
      viewportPageTop: win.getComputedStyle(doc.documentElement).getPropertyValue('--visual-viewport-page-top').trim(),
      editableFocused: Boolean(focused?.matches('input, textarea, select, [role="textbox"]') ||
        focused?.isContentEditable || focused?.closest('[contenteditable="true"], [contenteditable=""]'))
    }
  }

  const capture = (reason = 'manual') => {
    if (!active) return
    // Callers supply fixed action names; do not accept arbitrary text as metadata.
    const label = /^(manual|copy|download|export|start|stop|freeze|baseline|hidden|visible|pageshow|orientationchange|resize|focus|viewport-resize|viewport-scroll)(:(frame|250ms|1000ms|2000ms))?$/.test(reason)
      ? reason : 'manual'
    const sample = snapshot(label)
    if (!sample.hidden) {
      lastVisible = sample
      // Keep the initial settled geometry even when later events fill history.
      // A first return from the background must not become the normal baseline.
      if (!report.settledBaseline && !hasBackgrounded && sample.elapsedMs >= 1000) {
        report.settledBaseline = sample
      }
    }
    report.samples.push(sample)
    if (report.samples.length > HISTORY_LIMIT) report.samples.shift()
    lastSample = win.performance.now()
    return sample
  }

  const cancelPending = () => {
    if (frame !== null) win.cancelAnimationFrame(frame)
    if (sampleTimer !== null) win.clearTimeout(sampleTimer)
    settleTimers.forEach(timer => win.clearTimeout(timer))
    frame = sampleTimer = null
    settleTimers = []
  }

  const settle = reason => {
    cancelPending()
    capture(reason)
    if (doc.hidden) return
    frame = win.requestAnimationFrame(() => {
      frame = null
      capture(`${reason}:frame`)
    })
    settleTimers = [250, 1000, 2000].map(delay => win.setTimeout(() => {
      if (!doc.hidden) capture(`${reason}:${delay}ms`)
    }, delay))
  }

  const throttled = reason => {
    if (doc.hidden) return
    const remaining = SAMPLE_INTERVAL - (win.performance.now() - lastSample)
    if (remaining <= 0) capture(reason)
    else if (sampleTimer === null) {
      sampleTimer = win.setTimeout(() => {
        sampleTimer = null
        if (!doc.hidden) capture(reason)
      }, remaining)
    }
  }

  const listen = (target, event, handler) => {
    if (!target) return
    target.addEventListener(event, handler, true)
    listeners.push(() => target.removeEventListener(event, handler, true))
  }

  const stop = () => {
    active = false
    cancelPending()
    listeners.forEach(remove => remove())
    listeners = []
    probe?.remove()
    probe = null
  }

  const start = () => {
    stop()
    startedAt = win.performance.now()
    lastSample = -Infinity
    lastVisible = null
    hasBackgrounded = false
    probe = doc.createElement('div')
    probe.setAttribute('aria-hidden', 'true')
    probe.style.cssText = 'position:fixed;inset:0 auto auto 0;width:0;height:0;box-sizing:border-box;visibility:hidden;pointer-events:none;overflow:hidden;padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)'
    doc.body.append(probe)
    active = true
    report = {
      schema: 1, version: String(version), userAgent: win.navigator.userAgent,
      baseline: snapshot('baseline'), settledBaseline: null, beforeBackground: null, samples: []
    }
    if (!report.baseline.hidden) lastVisible = report.baseline
    listen(doc, 'visibilitychange', () => {
      if (doc.hidden) {
        // Hidden documents may already report zero or stale dimensions.
        report.beforeBackground = lastVisible
        hasBackgrounded = true
      }
      settle(doc.hidden ? 'hidden' : 'visible')
    })
    listen(win, 'pageshow', () => settle('pageshow'))
    listen(win, 'orientationchange', () => settle('orientationchange'))
    listen(win, 'focus', event => { if (event.target === win) settle('focus') })
    listen(win, 'resize', () => throttled('resize'))
    listen(win.visualViewport, 'resize', () => throttled('viewport-resize'))
    listen(win.visualViewport, 'scroll', () => throttled('viewport-scroll'))
    // A menu may still be closing when recording starts. Keep that first sample
    // and re-read after its animation without modifying focus or layout.
    settle('start')
  }

  return {
    start,
    stop,
    capture,
    exportReport: () => JSON.stringify(report, null, 2)
  }
}

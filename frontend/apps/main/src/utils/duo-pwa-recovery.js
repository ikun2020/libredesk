import { hasIPhoneDuoScreen, DUO_INNER_MIN_WIDTH, DUO_INNER_MAX_WIDTH } from '../composables/useIPhoneDuoInbox'

const editable = element => Boolean(element?.matches('input, textarea, select, [role="textbox"]') ||
  element?.isContentEditable || element?.closest('[contenteditable="true"], [contenteditable=""]'))
const near = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 1

// Explicit, page-session-only experiment. This asks WebKit to recompute its
// insets; it never forces the app beyond the browser's actual drawable viewport.
export function createDuoPwaRecovery ({ win = window, onChange = () => {}, capture = () => {} } = {}) {
  const doc = win.document
  let report = { enabled: false, status: 'disabled', baseline: null, attempts: [] }
  let listeners = []
  let checkTimer = null
  let armTimer = null
  let pulse = null
  let previous = null
  let deadline = 0
  let cycleStarted = -Infinity
  let attempted = false
  let keyboardDeferred = false

  const isSupported = () => hasIPhoneDuoScreen(win) && win.devicePixelRatio === 3 &&
    win.matchMedia('(pointer: coarse)').matches &&
    (win.navigator.standalone === true || win.matchMedia('(display-mode: standalone)').matches)

  const measure = () => {
    const vv = win.visualViewport
    return {
      width: doc.documentElement.clientWidth, height: doc.documentElement.clientHeight,
      innerWidth: win.innerWidth, innerHeight: win.innerHeight,
      visualWidth: vv?.width, visualHeight: vv?.height, scale: vv?.scale,
      offsetTop: vv?.offsetTop, offsetLeft: vv?.offsetLeft,
      pageTop: vv?.pageTop, pageLeft: vv?.pageLeft,
      scrollX: win.scrollX, scrollY: win.scrollY,
      orientation: win.screen.orientation?.type ?? null,
      angle: win.screen.orientation?.angle ?? null,
      hidden: doc.hidden, editing: editable(doc.activeElement)
    }
  }

  const usable = m => isSupported() && !m.hidden && !m.editing && m.scale === 1 &&
    m.width >= DUO_INNER_MIN_WIDTH && m.width <= DUO_INNER_MAX_WIDTH && m.height >= 320 &&
    near(m.width, m.innerWidth) && near(m.width, m.visualWidth) &&
    near(m.height, m.innerHeight) && near(m.height, m.visualHeight) &&
    [m.offsetTop, m.offsetLeft, m.pageTop, m.pageLeft, m.scrollX, m.scrollY].every(v => v === 0)

  const sameWindow = (a, b) => a && b && near(a.width, b.width) &&
    a.orientation === b.orientation && a.angle === b.angle

  const setStatus = status => {
    report.status = status
    onChange({ enabled: report.enabled, status })
  }

  const clearCheck = () => {
    win.clearTimeout(checkTimer)
    checkTimer = null
  }

  const cancelPulse = () => {
    pulse?.cancel()
    pulse = null
  }

  const suspend = () => {
    clearCheck()
    cancelPulse()
    deadline = 0
    cycleStarted = -Infinity
    previous = null
    attempted = false
    keyboardDeferred = false
  }

  const attempt = before => {
    const meta = doc.querySelector('meta[name="viewport"]')
    const original = meta?.getAttribute('content')
    if (!original) { setStatus('cancelled'); return }
    attempted = true
    clearCheck()
    // A different fit value triggers the viewport configuration path. Unlike
    // height=... it does not prescribe a size or restrict the user's zoom.
    const fit = /(?:^|[,;\s])viewport-fit\s*=\s*cover\b/i.test(original) ? 'contain' : 'cover'
    const temporary = /viewport-fit\s*=\s*[^,;\s]+/i.test(original)
      ? original.replace(/viewport-fit\s*=\s*[^,;\s]+/ig, `viewport-fit=${fit}`)
      : `${original}, viewport-fit=${fit}`
    const result = {
      before, during: null, after: null, metaRestored: false,
      outcome: 'pending', strategy: 'viewport-fit-pulse'
    }
    report.attempts.push(result)
    if (report.attempts.length > 6) report.attempts.shift()
    let frame = null
    let fallback = null
    let observation = null
    let restored = false
    const restore = () => {
      if (frame !== null) win.cancelAnimationFrame(frame)
      win.clearTimeout(fallback)
      frame = fallback = null
      if (restored) return
      result.during = measure()
      capture('duo-recovery:during')
      // Do not overwrite a newer viewport change from another owner.
      if (meta.isConnected && meta.getAttribute('content') === temporary) {
        meta.setAttribute('content', original)
        result.metaRestored = true
      }
      restored = true
      capture('duo-recovery:restored')
    }
    const current = {
      cancel: () => {
        restore()
        win.clearTimeout(observation)
        result.after = measure()
        result.outcome = 'cancelled'
        setStatus('cancelled')
      }
    }
    const restoreAndObserve = () => {
      if (pulse !== current || restored) return
      restore()
      observation = win.setTimeout(() => {
        if (pulse !== current) return
        result.after = measure()
        result.outcome = result.metaRestored && usable(result.after) &&
          sameWindow(result.after, report.baseline) && near(result.after.height, report.baseline.height)
          ? 'measured-restored' : 'not-restored'
        pulse = null
        capture('duo-recovery:after')
        setStatus(result.outcome)
      }, 1500)
    }
    pulse = current
    capture('duo-recovery:before')
    setStatus('attempting')
    meta.setAttribute('content', temporary)
    frame = win.requestAnimationFrame(() => {
      frame = win.requestAnimationFrame(restoreAndObserve)
    })
    // rAF can stall during an app transition. Always restore the original meta.
    fallback = win.setTimeout(restoreAndObserve, 150)
  }

  const check = () => {
    clearCheck()
    if (!report.enabled || !report.baseline || attempted || doc.hidden) return
    if (win.performance.now() > deadline) {
      if (report.status === 'checking') setStatus('deferred')
      return
    }
    const now = measure()
    if (usable(now) && sameWindow(now, report.baseline)) {
      const loss = report.baseline.height - now.height
      if (Math.abs(loss) < 1) {
        previous = null
        setStatus('ready')
        checkTimer = win.setTimeout(check, 250)
        return
      }
      // Narrow guard for the reported status-bar-sized loss, not a keyboard,
      // folded screen, changed orientation or genuinely different window.
      if (loss >= 40 && loss <= 160 && previous && sameWindow(now, previous) && near(now.height, previous.height)) {
        attempt(now)
        return
      }
      previous = now
      setStatus('checking')
    } else {
      previous = null
      if (now.editing) keyboardDeferred = true
      setStatus('deferred')
    }
    checkTimer = win.setTimeout(check, 250)
  }

  const resume = () => {
    if (!report.enabled || !report.baseline || doc.hidden || pulse || attempted) return
    // focus and visible commonly describe the same resume. Never start a loop
    // from resize events caused by our own metadata change.
    const now = win.performance.now()
    if (now - cycleStarted < 3000) return
    cycleStarted = now
    deadline = now + 6000
    attempted = false
    previous = null
    clearCheck()
    setStatus('checking')
    checkTimer = win.setTimeout(check, 250)
  }

  const listen = (target, event, handler) => {
    target?.addEventListener(event, handler, true)
    if (target) listeners.push(() => target.removeEventListener(event, handler, true))
  }

  const stop = () => {
    suspend()
    win.clearTimeout(armTimer)
    armTimer = null
    listeners.forEach(remove => remove())
    listeners = []
    report.enabled = false
    setStatus('disabled')
  }

  const start = () => {
    if (report.enabled) return true
    const baseline = measure()
    if (!usable(baseline) || !doc.querySelector('meta[name="viewport"]')?.getAttribute('content')) {
      setStatus('baseline-unavailable')
      return false
    }
    report = { enabled: true, status: 'arming', baseline: null, attempts: [] }
    setStatus('arming')
    armTimer = win.setTimeout(() => {
      armTimer = null
      const settled = measure()
      if (!usable(settled) || !sameWindow(settled, baseline) || !near(settled.height, baseline.height)) {
        stop()
        setStatus('baseline-unavailable')
        return
      }
      report.baseline = settled
      setStatus('ready')
    }, 500)
    listen(doc, 'visibilitychange', () => { if (doc.hidden) suspend(); else resume() })
    listen(win, 'pagehide', suspend)
    listen(win, 'blur', event => { if (event.target === win) suspend() })
    listen(win, 'focus', event => { if (event.target === win) resume() })
    listen(win, 'pageshow', resume)
    listen(win, 'orientationchange', () => {
      cancelPulse()
      previous = null
      // Keep the original baseline across the transient outer-display reports.
    })
    listen(doc, 'focusin', event => { if (editable(event.target)) { cancelPulse(); previous = null } })
    listen(doc, 'focusout', () => {
      // A reply can stay focused longer than the bounded foreground checks.
      // Once the user dismisses it, allow one fresh short observation window.
      if (keyboardDeferred && !attempted && report.baseline) {
        keyboardDeferred = false
        deadline = win.performance.now() + 2000
      }
      if (report.baseline && !attempted && win.performance.now() < deadline) {
        clearCheck()
        checkTimer = win.setTimeout(check, 250)
      }
    })
    listen(win.visualViewport, 'resize', () => {
      if (!pulse) return
      // The fit pulse itself can change width/height in stages. Only user zoom,
      // keyboard or pan interrupts it; intermediate sizes are diagnostic data.
      const m = measure()
      if (m.editing || m.hidden || m.scale !== 1 ||
        [m.offsetTop, m.offsetLeft, m.pageTop, m.pageLeft].some(v => v !== 0)) cancelPulse()
    })
    listen(win.visualViewport, 'scroll', () => { if (pulse && !usable(measure())) cancelPulse() })
    return true
  }

  return { isSupported, start, stop, getReport: () => JSON.parse(JSON.stringify(report)) }
}

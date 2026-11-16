// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDuoPwaRecovery } from './duo-pwa-recovery'

const ORIGINAL_META = 'width=device-width, initial-scale=1, interactive-widget=resizes-visual'

let recovery
let viewport
let screen
let hidden
let clientHeight
let clientWidth
let meta
let originalMeta

function setGeometry({ width = 867, height = 669, ...visual } = {}) {
  vi.stubGlobal('innerWidth', width)
  vi.stubGlobal('innerHeight', height)
  clientWidth.mockReturnValue(width)
  clientHeight.mockReturnValue(height)
  Object.assign(viewport, { width, height, ...visual })
}

function pickMedia({ standalone = true, coarse = true } = {}) {
  vi.stubGlobal('matchMedia', query => ({
    matches: query.includes('display-mode') ? standalone : query.includes('pointer') && coarse
  }))
}

function signalForeground(event = 'focus') {
  const target = event === 'visibilitychange' ? document : window
  const signal = new Event(event)
  // Vitest's jsdom global is a proxy for the event's internal window target.
  if (event === 'focus' || event === 'blur') Object.defineProperty(signal, 'target', { value: window })
  target.dispatchEvent(signal)
}

function arm() {
  expect(recovery.start()).toBe(true)
  expect(meta.content).toBe(originalMeta)
  vi.advanceTimersByTime(500)
  expect(recovery.getReport().baseline).toBeTruthy()
  expect(meta.content).toBe(originalMeta)
}

function startPulse(event) {
  setGeometry({ height: 587 })
  signalForeground(event)
  vi.advanceTimersByTime(499)
  expect(meta.content).toBe(originalMeta)
  vi.advanceTimersByTime(1)
}

beforeEach(() => {
  vi.useFakeTimers()
  hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  clientWidth = vi.spyOn(document.documentElement, 'clientWidth', 'get')
  clientHeight = vi.spyOn(document.documentElement, 'clientHeight', 'get')
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15')
  viewport = Object.assign(new EventTarget(), {
    scale: 1, offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0
  })
  screen = { width: 466, height: 678, orientation: { type: 'landscape-secondary', angle: 270 } }
  vi.stubGlobal('visualViewport', viewport)
  vi.stubGlobal('screen', screen)
  vi.stubGlobal('devicePixelRatio', 3)
  vi.stubGlobal('scrollX', 0)
  vi.stubGlobal('scrollY', 0)
  pickMedia()
  setGeometry()
  document.body.innerHTML = '<div id="app"><div class="app-shell"><input value="PRIVATE DRAFT"></div></div>'
  meta = document.createElement('meta')
  meta.name = 'viewport'
  meta.content = originalMeta = ORIGINAL_META
  document.head.append(meta)
  recovery = createDuoPwaRecovery()
})

afterEach(() => {
  recovery.stop()
  meta.remove()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('opt-in iPhone Duo PWA recovery', () => {
  it.each(['ordinary iPhone', 'Safari tab', 'fine pointer', 'non-matching scale factor'])(
    'does not touch viewport metadata in a %s', mode => {
      if (mode === 'ordinary iPhone') Object.assign(screen, { width: 402, height: 874 })
      if (mode === 'Safari tab') pickMedia({ standalone: false })
      if (mode === 'fine pointer') pickMedia({ coarse: false })
      if (mode === 'non-matching scale factor') vi.stubGlobal('devicePixelRatio', 2)
      expect(recovery.isSupported()).toBe(false)
      expect(recovery.start()).toBe(false)
      setGeometry({ height: 587 })
      signalForeground('pageshow')
      vi.advanceTimersByTime(4000)
      expect(meta.content).toBe(originalMeta)
      expect(recovery.getReport().attempts).toHaveLength(0)
    }
  )

  it('checks twice after foregrounding, restores exact meta, and records a measured recovery', () => {
    expect(recovery.isSupported()).toBe(true)
    arm()
    startPulse('pageshow')
    expect(meta.content).toContain('viewport-fit=cover')
    expect(meta.content).toContain(ORIGINAL_META)
    expect(meta.content).not.toMatch(/user-scalable|maximum-scale|minimum-scale|height=/)

    setGeometry()
    vi.advanceTimersByTime(60)
    expect(meta.content).toBe(originalMeta)
    vi.advanceTimersByTime(1600)
    expect(recovery.getReport().attempts).toEqual([
      expect.objectContaining({
        before: expect.any(Object), during: expect.any(Object), after: expect.any(Object),
        metaRestored: true, outcome: 'measured-restored'
      })
    ])
  })

  it('does not arm from a baseline that changes during startup', () => {
    expect(recovery.start()).toBe(true)
    expect(recovery.getReport().baseline).toBeNull()
    setGeometry({ height: 587 })
    vi.advanceTimersByTime(500)
    expect(recovery.getReport()).toMatchObject({ enabled: false, baseline: null, attempts: [] })
    signalForeground('pageshow')
    vi.advanceTimersByTime(1000)
    expect(meta.content).toBe(originalMeta)
  })

  it('toggles existing cover to contain, then restores the exact original without repeatedly trying', () => {
    meta.content = originalMeta = 'width=device-width , viewport-fit=cover,  interactive-widget=resizes-visual, initial-scale=1'
    arm()
    startPulse()
    expect(meta.content).toContain('viewport-fit=contain')
    expect(meta.content).not.toContain('viewport-fit=cover')
    vi.advanceTimersByTime(2000)
    expect(meta.content).toBe(originalMeta)
    expect(recovery.getReport().attempts).toEqual([
      expect.objectContaining({ metaRestored: true, outcome: 'not-restored' })
    ])

    viewport.dispatchEvent(new Event('resize'))
    signalForeground()
    signalForeground('pageshow')
    signalForeground('visibilitychange')
    vi.advanceTimersByTime(10000)
    expect(meta.content).toBe(originalMeta)
    expect(recovery.getReport().attempts).toHaveLength(1)
  })

  it('ignores the transient folded width but recognizes two matching wide samples after returning', () => {
    arm()
    setGeometry({ width: 466, height: 596 })
    signalForeground('visibilitychange')
    vi.advanceTimersByTime(200)
    expect(meta.content).toBe(originalMeta)

    setGeometry({ height: 587 })
    vi.advanceTimersByTime(300)
    expect(meta.content).toContain('viewport-fit=cover')
    expect(recovery.getReport().attempts).toHaveLength(1)
  })

  it('detects a delayed height loss after a healthy first foreground sample', () => {
    arm()
    signalForeground()
    vi.advanceTimersByTime(300)
    expect(meta.content).toBe(originalMeta)

    setGeometry({ height: 587 })
    vi.advanceTimersByTime(200)
    expect(recovery.getReport().attempts).toHaveLength(0)
    vi.advanceTimersByTime(250)
    expect(meta.content).toContain('viewport-fit=cover')
    expect(recovery.getReport().attempts).toHaveLength(1)
  })

  it('does not pulse when the two sampled sizes disagree', () => {
    arm()
    setGeometry({ height: 596 })
    signalForeground()
    vi.advanceTimersByTime(250)
    setGeometry({ height: 587 })
    vi.advanceTimersByTime(250)
    expect(meta.content).toBe(originalMeta)
    expect(recovery.getReport().attempts).toHaveLength(0)
  })

  it('does not treat a visual-viewport-only height change as a shorter native window', () => {
    arm()
    viewport.height = 587
    signalForeground('pageshow')
    vi.advanceTimersByTime(1000)
    expect(meta.content).toBe(originalMeta)
    expect(recovery.getReport().attempts).toHaveLength(0)
  })

  it.each([
    ['pinch zoom', { scale: 0.912 }],
    ['visual panning', { offsetTop: 82, pageTop: 82 }],
    ['a minor height change', { height: 636 }],
    ['a large height change', { height: 460 }],
    ['the folded display', { width: 466 }]
  ])('does not pulse for %s', (_name, geometry) => {
    arm()
    setGeometry({ height: 587, ...geometry })
    signalForeground()
    vi.advanceTimersByTime(1000)
    expect(meta.content).toBe(originalMeta)
    expect(recovery.getReport().attempts).toHaveLength(0)
  })

  it('keeps focus and draft intact while editing, then checks again after blur', () => {
    arm()
    const input = document.querySelector('input')
    input.focus()
    input.setSelectionRange(2, 5)
    setGeometry({ height: 587 })
    signalForeground()
    vi.advanceTimersByTime(700)
    expect(document.activeElement).toBe(input)
    expect(input.value).toBe('PRIVATE DRAFT')
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 5])
    expect(meta.content).toBe(originalMeta)
    expect(recovery.getReport().attempts).toHaveLength(0)

    input.blur()
    vi.advanceTimersByTime(500)
    expect(meta.content).toContain('viewport-fit=cover')
    expect(input.value).toBe('PRIVATE DRAFT')
    expect(JSON.stringify(recovery.getReport())).not.toContain('PRIVATE DRAFT')
  })

  it('ends polling while the editor stays focused and retries once after dismissal', () => {
    arm()
    const input = document.querySelector('input')
    input.focus()
    input.setSelectionRange(2, 5)
    setGeometry({ height: 587 })
    signalForeground('pageshow')
    vi.advanceTimersByTime(6250)
    expect(vi.getTimerCount()).toBe(0)
    expect(document.activeElement).toBe(input)
    expect(input.value).toBe('PRIVATE DRAFT')
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 5])
    expect(meta.content).toBe(originalMeta)

    input.blur()
    vi.advanceTimersByTime(500)
    expect(meta.content).toContain('viewport-fit=cover')
    vi.advanceTimersByTime(10000)
    expect(meta.content).toBe(originalMeta)
    expect(recovery.getReport().attempts).toHaveLength(1)
    expect(input.value).toBe('PRIVATE DRAFT')
  })

  it('restores metadata using the fallback when frames do not run', () => {
    vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1)
    arm()
    startPulse()
    expect(meta.content).toContain('viewport-fit=cover')
    vi.advanceTimersByTime(149)
    expect(meta.content).toContain('viewport-fit=cover')
    vi.advanceTimersByTime(1)
    expect(meta.content).toBe(originalMeta)
  })

  it('restores and cancels an active pulse at stop, and subsequent events do not write', () => {
    arm()
    startPulse()
    expect(meta.content).toContain('viewport-fit=cover')
    recovery.stop()
    expect(meta.content).toBe(originalMeta)
    expect(recovery.getReport().enabled).toBe(false)
    const metadata = vi.spyOn(meta, 'setAttribute')
    signalForeground()
    signalForeground('pageshow')
    signalForeground('visibilitychange')
    vi.advanceTimersByTime(10000)
    expect(metadata).not.toHaveBeenCalled()
  })

  it('does not overwrite a metadata update made outside the recovery', () => {
    arm()
    startPulse()
    expect(meta.content).toContain('viewport-fit=cover')
    const externallyChanged = `${ORIGINAL_META}, viewport-fit=auto`
    meta.content = externallyChanged
    vi.advanceTimersByTime(2000)
    recovery.stop()
    expect(meta.content).toBe(externallyChanged)
  })

  it('restores on hide and allows at most one pulse on the next foreground', () => {
    arm()
    startPulse()
    expect(meta.content).toContain('viewport-fit=cover')
    hidden.mockReturnValue(true)
    signalForeground('visibilitychange')
    expect(meta.content).toBe(originalMeta)
    vi.advanceTimersByTime(4000)
    hidden.mockReturnValue(false)
    signalForeground('visibilitychange')
    vi.advanceTimersByTime(500)
    expect(meta.content).toContain('viewport-fit=cover')
    expect(recovery.getReport().attempts).toHaveLength(2)
  })

  it.each(['pagehide', 'blur', 'visibilitychange'])(
    'ignores a delayed pageshow and rearms only after %s', suspension => {
      arm()
      startPulse('pageshow')
      vi.advanceTimersByTime(4000)
      expect(meta.content).toBe(originalMeta)

      signalForeground('pageshow')
      vi.advanceTimersByTime(500)
      expect(meta.content).toBe(originalMeta)
      expect(recovery.getReport().attempts).toHaveLength(1)

      if (suspension === 'visibilitychange') hidden.mockReturnValue(true)
      signalForeground(suspension)
      hidden.mockReturnValue(false)
      signalForeground('pageshow')
      vi.advanceTimersByTime(500)
      expect(meta.content).toContain('viewport-fit=cover')
      expect(recovery.getReport().attempts).toHaveLength(2)
    }
  )
})

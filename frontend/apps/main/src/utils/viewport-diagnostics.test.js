// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createViewportRecorder } from './viewport-diagnostics'

let recorder
let viewport
let hidden
let shell
const read = () => JSON.parse(recorder.exportReport())
const rect = top => ({ x: 0, y: top, top, right: 900, bottom: top + 700, left: 0, width: 900, height: 700 })

beforeEach(() => {
  vi.useFakeTimers()
  hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  vi.stubGlobal('matchMedia', vi.fn(query => ({ matches: query.includes('standalone') || query.includes('coarse') })))
  vi.stubGlobal('scrollX', 0)
  vi.stubGlobal('scrollY', 0)
  viewport = Object.assign(new EventTarget(), {
    width: 900, height: 700, scale: 1, offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0
  })
  vi.stubGlobal('visualViewport', viewport)
  document.body.innerHTML = '<div id="app"><div class="app-shell"><input value="PRIVATE-DRAFT"><div>PRIVATE-CHAT</div></div></div>'
  shell = document.querySelector('.app-shell')
  vi.spyOn(shell, 'getBoundingClientRect').mockReturnValue(rect(0))
  recorder = createViewportRecorder({ version: 'v2.9.2+git.test' })
})

afterEach(() => {
  recorder.stop()
  document.body.innerHTML = ''
  document.documentElement.style.removeProperty('--visual-viewport-height')
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('opt-in viewport diagnostic recorder', () => {
  it('does nothing before being started, including an explicit capture call', () => {
    const add = vi.spyOn(window, 'addEventListener')
    const children = document.body.childElementCount
    recorder.capture('copy')
    window.dispatchEvent(new Event('pageshow'))
    expect(read()).toBeNull()
    expect(add).not.toHaveBeenCalled()
    expect(document.body.childElementCount).toBe(children)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('distinguishes visual viewport displacement from document and element displacement', () => {
    recorder.start()
    viewport.offsetTop = -84
    viewport.pageTop = -84
    recorder.capture('copy')
    let sample = read().samples.at(-1)
    expect(sample.window.scrollY).toBe(0)
    expect(sample.elements.shell.rect.top).toBe(0)
    expect(sample.visualViewport.offsetTop).toBe(-84)
    expect(sample.visualViewport.pageTop).toBe(-84)

    viewport.offsetTop = viewport.pageTop = 0
    shell.getBoundingClientRect.mockReturnValue(rect(110))
    recorder.capture('manual')
    sample = read().samples.at(-1)
    expect(sample.window.scrollY).toBe(0)
    expect(sample.visualViewport.offsetTop).toBe(0)
    expect(sample.elements.shell.rect.top).toBe(110)
    expect(read().baseline.elements.shell.rect.top).toBe(0)
  })

  it('captures lifecycle geometry before existing recovery listeners and after delayed settling', () => {
    const restore = () => { if (!document.hidden) viewport.offsetTop = 0 }
    document.addEventListener('visibilitychange', restore)
    recorder.start()
    hidden.mockReturnValue(true)
    document.dispatchEvent(new Event('visibilitychange'))
    const hiddenCount = read().samples.length
    vi.advanceTimersByTime(5000)
    expect(read().samples).toHaveLength(hiddenCount)
    viewport.offsetTop = -84
    hidden.mockReturnValue(false)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(read().samples.at(-1)).toMatchObject({ reason: 'visible', visualViewport: { offsetTop: -84 } })
    vi.advanceTimersByTime(20)
    expect(read().samples.at(-1)).toMatchObject({ reason: 'visible:frame', visualViewport: { offsetTop: 0 } })
    viewport.height = 620
    vi.advanceTimersByTime(230)
    expect(read().samples.at(-1)).toMatchObject({ reason: 'visible:250ms', visualViewport: { height: 620 } })
    viewport.height = 650
    vi.advanceTimersByTime(750)
    expect(read().samples.at(-1)).toMatchObject({ reason: 'visible:1000ms', visualViewport: { height: 650 } })
    viewport.height = 700
    vi.advanceTimersByTime(1000)
    expect(read().samples.at(-1)).toMatchObject({ reason: 'visible:2000ms', visualViewport: { height: 700 } })
    const settledCount = read().samples.length
    vi.advanceTimersByTime(10000)
    expect(read().samples).toHaveLength(settledCount)
    document.removeEventListener('visibilitychange', restore)
  })

  it('keeps a bounded timeline under rapid viewport events while retaining the baseline', () => {
    recorder.start()
    vi.advanceTimersByTime(2000)
    const baseline = read().baseline
    const count = read().samples.length
    for (let index = 0; index < 100; index++) viewport.dispatchEvent(new Event('scroll'))
    expect(read().samples.length).toBeLessThanOrEqual(count + 1)
    for (let index = 0; index < 60; index++) {
      viewport.offsetTop = index
      viewport.dispatchEvent(new Event('resize'))
      vi.advanceTimersByTime(150)
    }
    expect(read().samples).toHaveLength(24)
    expect(read().samples.at(-1).visualViewport.offsetTop).toBe(59)
    expect(read().baseline).toEqual(baseline)
  })

  it('retains settled and pre-background geometry when the bounded timeline rolls over', () => {
    recorder.start()
    vi.advanceTimersByTime(600)
    // A focus event can replace the initial settling callbacks.
    window.dispatchEvent(new Event('focus'))
    viewport.height = 680
    vi.advanceTimersByTime(1000)
    const settled = read().settledBaseline
    expect(settled).toMatchObject({ hidden: false, visualViewport: { height: 680 } })
    viewport.height = 700
    recorder.capture('manual')
    const beforeBackground = read().samples.at(-1)
    hidden.mockReturnValue(true)
    viewport.height = 0
    document.dispatchEvent(new Event('visibilitychange'))
    expect(read().beforeBackground).toEqual(beforeBackground)
    expect(read().beforeBackground.visualViewport.height).toBe(700)
    hidden.mockReturnValue(false)
    viewport.height = 620
    viewport.offsetTop = -84
    document.dispatchEvent(new Event('visibilitychange'))
    for (let index = 0; index < 60; index++) {
      viewport.dispatchEvent(new Event('resize'))
      vi.advanceTimersByTime(150)
    }
    expect(read().samples).toHaveLength(24)
    expect(read().samples).not.toContainEqual(beforeBackground)
    expect(read().settledBaseline).toEqual(settled)
    expect(read().beforeBackground).toEqual(beforeBackground)

    recorder.start()
    expect(read().settledBaseline).toBeNull()
    expect(read().beforeBackground).toBeNull()
  })

  it('does not mistake the first restored layout for the settled baseline after an early hide', () => {
    recorder.start()
    hidden.mockReturnValue(true)
    document.dispatchEvent(new Event('visibilitychange'))
    vi.advanceTimersByTime(1500)
    hidden.mockReturnValue(false)
    viewport.offsetTop = -84
    document.dispatchEvent(new Event('visibilitychange'))
    vi.advanceTimersByTime(2000)
    expect(read().settledBaseline).toBeNull()
    expect(read().beforeBackground.visualViewport.offsetTop).toBe(0)
  })

  it('never exports chat, draft, account, URL or storage content and never changes focus or scrolling', () => {
    const input = document.querySelector('input')
    input.focus()
    const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    const fetch = vi.spyOn(window, 'fetch')
    const storage = vi.spyOn(Storage.prototype, 'getItem')
    window.history.replaceState({}, '', '/inboxes/private-conversation?token=PRIVATE-TOKEN')
    document.title = 'PRIVATE-ACCOUNT'
    document.cookie = 'private=PRIVATE-COOKIE'
    recorder.start()
    recorder.capture('https://private.example/PRIVATE-SECRET')
    const exported = recorder.exportReport()
    expect(exported).not.toMatch(/PRIVATE|private-conversation|cookie|location|href|innerHTML|textContent/)
    expect(read().samples.at(-1).reason).toBe('manual')
    expect(read().baseline.editableFocused).toBe(true)
    expect(document.activeElement).toBe(input)
    expect(input.value).toBe('PRIVATE-DRAFT')
    expect(scroll).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(storage).not.toHaveBeenCalled()
    window.history.replaceState({}, '', '/')
  })

  it('ignores focus on child controls and removes all listeners, timers and the probe on stop', () => {
    const removals = [
      vi.spyOn(window, 'removeEventListener'),
      vi.spyOn(document, 'removeEventListener'),
      vi.spyOn(viewport, 'removeEventListener')
    ]
    recorder.start()
    const count = read().samples.length
    document.querySelector('input').focus()
    expect(read().samples).toHaveLength(count)
    // jsdom queues a selectionchange task when the input gains focus.
    vi.advanceTimersByTime(0)
    expect(document.body.childElementCount).toBe(2)
    recorder.stop()
    const saved = recorder.exportReport()
    expect(document.body.childElementCount).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
    expect(removals.map(spy => spy.mock.calls.length)).toEqual([4, 2, 2])
    window.dispatchEvent(new Event('focus'))
    window.dispatchEvent(new Event('pageshow'))
    viewport.dispatchEvent(new Event('resize'))
    document.dispatchEvent(new Event('visibilitychange'))
    recorder.capture('copy')
    vi.advanceTimersByTime(5000)
    expect(recorder.exportReport()).toBe(saved)
  })

  it('starts a fresh bounded session without duplicate listeners or stale baseline', () => {
    recorder.start()
    viewport.offsetTop = -84
    recorder.capture('manual')
    recorder.start()
    expect(read().baseline.visualViewport.offsetTop).toBe(-84)
    expect(read().samples).toHaveLength(1)
    expect(document.body.childElementCount).toBe(2)
    hidden.mockReturnValue(true)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(read().samples.filter(sample => sample.reason === 'hidden')).toHaveLength(1)
  })

  it('works without VisualViewport and reports a missing app shell without reading page content', () => {
    vi.stubGlobal('visualViewport', undefined)
    shell.remove()
    recorder.start()
    expect(read().baseline.visualViewport).toBeNull()
    expect(read().baseline.elements.shell).toBeNull()
    expect(read().baseline.window.innerHeight).toBe(window.innerHeight)
  })
})

describe('manual viewport recalculation experiment', () => {
  const originalContent = 'width=device-width, initial-scale=1, interactive-widget=resizes-visual'
  let meta

  const prepare = () => {
    vi.stubGlobal('innerWidth', 900)
    meta = document.createElement('meta')
    meta.setAttribute('name', 'viewport')
    meta.setAttribute('content', originalContent)
    meta.setAttribute('data-original', 'preserved')
    document.head.append(meta)
    recorder.start()
    vi.advanceTimersByTime(1000)
    viewport.height = 620
  }

  afterEach(() => {
    recorder.stop()
    meta?.remove()
    meta = null
  })

  it('only changes metadata on an explicit request, restores it exactly, and retains before/after geometry', () => {
    prepare()
    const attributes = meta.outerHTML
    window.dispatchEvent(new Event('pageshow'))
    expect(meta.outerHTML).toBe(attributes)
    expect(read().viewportRecalculation).toBeNull()
    const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    const input = document.querySelector('input')

    expect(recorder.recalculateViewport()).toBe(true)
    expect(meta.content).toBe(`${originalContent}, height=700`)
    expect(meta.content).not.toMatch(/user-scalable|maximum-scale|minimum-scale/)
    expect(recorder.recalculateViewport()).toBe(false)
    expect(read().viewportRecalculation).toMatchObject({
      manual: true, requestedHeight: 700, metaRestored: false,
      before: { visualViewport: { height: 620 } }, after: null
    })
    vi.advanceTimersByTime(50)
    expect(meta.outerHTML).toBe(attributes)
    expect(read().viewportRecalculation.metaRestored).toBe(true)
    viewport.height = 700
    vi.advanceTimersByTime(1100)
    expect(read().viewportRecalculation).toMatchObject({
      interrupted: false, after: { reason: 'viewport-recalculate:after', visualViewport: { height: 700 } }
    })
    expect(read().settledBaseline.visualViewport.height).toBe(700)
    expect(input.value).toBe('PRIVATE-DRAFT')
    expect(document.activeElement).toBe(document.body)
    expect(scroll).not.toHaveBeenCalled()
    expect(recorder.exportReport()).not.toContain(originalContent)
  })

  it('restores the original metadata within 250ms when animation frames do not run', () => {
    prepare()
    vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(999)
    expect(recorder.recalculateViewport()).toBe(true)
    vi.advanceTimersByTime(250)
    expect(meta.content).toBe(originalContent)
    expect(read().viewportRecalculation.metaRestored).toBe(true)
    vi.advanceTimersByTime(1000)
    expect(read().viewportRecalculation.after.visualViewport.height).toBe(620)
  })

  it.each(['stop', 'hidden', 'orientation', 'editing', 'zoom'])(
    'restores immediately and cancels observation when interrupted by %s', mode => {
      prepare()
      expect(recorder.recalculateViewport()).toBe(true)
      if (mode === 'stop') recorder.stop()
      if (mode === 'hidden') {
        hidden.mockReturnValue(true)
        document.dispatchEvent(new Event('visibilitychange'))
      }
      if (mode === 'orientation') window.dispatchEvent(new Event('orientationchange'))
      if (mode === 'editing') document.querySelector('input').focus()
      if (mode === 'zoom') {
        viewport.scale = 2
        viewport.dispatchEvent(new Event('resize'))
      }
      expect(meta.content).toBe(originalContent)
      expect(read().viewportRecalculation).toMatchObject({ metaRestored: true, interrupted: true, after: null })
      vi.advanceTimersByTime(2000)
      expect(meta.content).toBe(originalContent)
      expect(read().viewportRecalculation.after).toBeNull()
    }
  )

  it.each(['zoom', 'folded width', 'keyboard focus', 'hidden', 'existing height', 'browser tab', 'short baseline'])(
    'rejects an unsafe or inconclusive experiment with %s', mode => {
      prepare()
      if (mode === 'zoom') viewport.scale = 0.912
      if (mode === 'folded width') viewport.width = 466
      if (mode === 'keyboard focus') document.querySelector('input').focus()
      if (mode === 'hidden') hidden.mockReturnValue(true)
      if (mode === 'existing height') meta.content = `${originalContent}, height=600`
      if (mode === 'browser tab') window.matchMedia.mockImplementation(query => ({ matches: query.includes('coarse') }))
      if (mode === 'short baseline') {
        // A baseline accidentally recorded with the keyboard up is not a
        // trustworthy request to enlarge the current viewport.
        viewport.height = 900
      }
      const unchanged = meta.outerHTML
      expect(recorder.recalculateViewport()).toBe(false)
      expect(meta.outerHTML).toBe(unchanged)
      expect(read().viewportRecalculation).toBeNull()
    }
  )
})

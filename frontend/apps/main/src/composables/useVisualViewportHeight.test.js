// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h } from 'vue'
import { useVisualViewportHeight } from './useVisualViewportHeight'

const property = '--visual-viewport-height'
const topProperty = '--visual-viewport-page-top'
const height = () => document.documentElement.style.getPropertyValue(property)
const pageTop = () => document.documentElement.style.getPropertyValue(topProperty)
let app
let host
let hidden
let portal

const mockViewport = (values = {}) => {
  const viewport = Object.assign(new EventTarget(), { height: 700, scale: 1 }, values)
  vi.stubGlobal('visualViewport', viewport)
  return viewport
}

const standaloneTouch = () => {
  window.matchMedia.mockImplementation(query => ({
    matches: ['(display-mode: standalone)', '(pointer: coarse)'].includes(query)
  }))
}

beforeEach(() => {
  vi.useFakeTimers()
  hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
  vi.stubGlobal('scrollTo', vi.fn())
  vi.stubGlobal('scrollX', 0)
  vi.stubGlobal('scrollY', 0)
})

const mount = () => {
  host = document.createElement('div')
  document.body.append(host)
  app = createApp({
    setup () {
      useVisualViewportHeight()
      return () => h('div', { class: 'app-shell' })
    }
  })
  app.mount(host)
}

afterEach(() => {
  app?.unmount()
  app = null
  host?.remove()
  portal?.remove()
  portal = null
  document.documentElement.style.removeProperty(property)
  document.documentElement.style.removeProperty(topProperty)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('visual viewport height', () => {
  it('tracks an overlay keyboard without a layout viewport resize and releases its listeners', () => {
    const viewport = new EventTarget()
    Object.assign(viewport, { height: 700, scale: 1 })
    vi.stubGlobal('visualViewport', viewport)
    vi.stubGlobal('innerHeight', 900)
    document.documentElement.style.setProperty(property, '650px')
    mount()
    expect(height()).toBe('700px')

    viewport.height = 350
    viewport.dispatchEvent(new Event('resize'))
    expect(height()).toBe('350px')
    expect(window.innerHeight).toBe(900)

    app.unmount()
    app = null
    expect(height()).toBe('650px')
    viewport.height = 600
    viewport.dispatchEvent(new Event('resize'))
    viewport.dispatchEvent(new Event('scroll'))
    window.dispatchEvent(new Event('resize'))
    window.dispatchEvent(new Event('pageshow'))
    window.dispatchEvent(new Event('focus'))
    window.dispatchEvent(new Event('orientationchange'))
    document.dispatchEvent(new Event('visibilitychange'))
    vi.advanceTimersByTime(1000)
    expect(height()).toBe('650px')
  })

  it('does not relayout the app while pinch zoom changes the visual viewport', () => {
    const viewport = new EventTarget()
    Object.assign(viewport, { height: 700, scale: 1 })
    vi.stubGlobal('visualViewport', viewport)
    mount()
    Object.assign(viewport, { height: 350, scale: 2 })
    viewport.dispatchEvent(new Event('resize'))
    expect(height()).toBe('700px')
    Object.assign(viewport, { height: 600, scale: 1 })
    viewport.dispatchEvent(new Event('resize'))
    expect(height()).toBe('600px')
  })

  it('uses the window height when the visual viewport API is unavailable', () => {
    vi.stubGlobal('visualViewport', undefined)
    vi.stubGlobal('innerHeight', 800)
    mount()
    expect(height()).toBe('800px')
    vi.stubGlobal('innerHeight', 400)
    window.dispatchEvent(new Event('resize'))
    expect(height()).toBe('400px')
    app.unmount()
    app = null
    expect(height()).toBe('')
    window.dispatchEvent(new Event('resize'))
    expect(height()).toBe('')
  })

  it.each([332, 0])('follows keyboard page coordinates through two open/close cycles with scrollY=%s', scrollY => {
    standaloneTouch()
    vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(669)
    const viewport = mockViewport({ width: 867, height: 669, pageTop: 0, offsetTop: 0 })
    mount()
    const pane = document.createElement('div')
    pane.scrollTop = 160
    const editable = document.createElement('div')
    editable.setAttribute('contenteditable', 'true')
    editable.textContent = 'Unsent reply'
    pane.append(editable)
    host.querySelector('.app-shell').append(pane)

    for (let cycle = 0; cycle < 2; cycle++) {
      editable.focus()
      const range = document.createRange()
      range.setStart(editable.firstChild, 3)
      range.collapse(true)
      const selection = window.getSelection()
      selection.removeAllRanges()
      selection.addRange(range)

      vi.stubGlobal('scrollY', scrollY)
      Object.assign(viewport, { height: 337, pageTop: 332, offsetTop: 332 })
      viewport.dispatchEvent(new Event('resize'))
      viewport.dispatchEvent(new Event('scroll'))
      window.dispatchEvent(new Event('pageshow'))
      vi.advanceTimersByTime(1000)
      expect(height()).toBe('337px')
      // WebKit can report scrollY and offsetTop as 332 simultaneously. The
      // document origin is pageTop=332, not their sum of 664.
      expect(pageTop()).toBe('332px')
      expect(document.activeElement).toBe(editable)
      expect(selection.anchorNode).toBe(editable.firstChild)
      expect(selection.anchorOffset).toBe(3)
      expect(editable.textContent).toBe('Unsent reply')
      expect(pane.scrollTop).toBe(160)
      expect(window.scrollTo).not.toHaveBeenCalled()

      // Focus may leave before the keyboard dismissal animation has finished.
      editable.blur()
      window.dispatchEvent(new Event('pageshow'))
      expect(pageTop()).toBe('332px')
      expect(window.scrollTo).not.toHaveBeenCalled()
      vi.stubGlobal('scrollY', 0)
      Object.assign(viewport, { height: 669, pageTop: 0, offsetTop: 0 })
      viewport.dispatchEvent(new Event('resize'))
      expect(height()).toBe('669px')
      expect(pageTop()).toBe('0px')
    }
  })

  it('does not reposition the shell when focus moves into a body-portal editor', () => {
    standaloneTouch()
    vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(669)
    const viewport = mockViewport({ height: 669, pageTop: 0 })
    mount()
    const input = document.createElement('textarea')
    host.querySelector('.app-shell').append(input)
    input.focus()
    Object.assign(viewport, { height: 337, pageTop: 332 })
    viewport.dispatchEvent(new Event('resize'))
    expect(pageTop()).toBe('332px')

    portal = document.createElement('textarea')
    portal.value = 'Dialog draft'
    document.body.append(portal)
    portal.focus()
    expect(pageTop()).toBe('0px')
    expect(height()).toBe('337px')
    expect(document.activeElement).toBe(portal)
    expect(portal.value).toBe('Dialog draft')
    expect(window.scrollTo).not.toHaveBeenCalled()
  })

  it('preserves the keyboard layout while pinch zoom changes the visual origin', () => {
    standaloneTouch()
    vi.stubGlobal('innerWidth', 867)
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(867)
    vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(669)
    const viewport = mockViewport({ width: 867, height: 669, pageTop: 0, offsetTop: 0, offsetLeft: 0 })
    mount()
    const input = document.createElement('input')
    host.querySelector('.app-shell').append(input)
    input.focus()
    Object.assign(viewport, { height: 337, pageTop: 332, offsetTop: 332 })
    viewport.dispatchEvent(new Event('resize'))
    for (const zoom of [
      { scale: 2, width: 433, height: 200, pageTop: 460 },
      { scale: 0.8, width: 1084, height: 420, pageTop: 0, offsetTop: 0 }
    ]) {
      Object.assign(viewport, zoom)
      viewport.dispatchEvent(new Event('resize'))
      viewport.dispatchEvent(new Event('scroll'))
      expect(height()).toBe('337px')
      expect(pageTop()).toBe('332px')
    }
    Object.assign(viewport, { scale: 1, width: 867, height: 669, pageTop: 0, offsetTop: 0 })
    viewport.dispatchEvent(new Event('resize'))
    expect(height()).toBe('669px')
    expect(pageTop()).toBe('0px')
    expect(document.activeElement).toBe(input)
    expect(window.scrollTo).not.toHaveBeenCalled()
  })

  it('restores both existing CSS properties and removes focus listeners on unmount', () => {
    standaloneTouch()
    vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(669)
    const viewport = mockViewport({ height: 669, pageTop: 0 })
    document.documentElement.style.setProperty(property, '650px')
    document.documentElement.style.setProperty(topProperty, '12px')
    mount()
    const input = document.createElement('input')
    host.querySelector('.app-shell').append(input)
    input.focus()
    Object.assign(viewport, { height: 337, pageTop: 332 })
    viewport.dispatchEvent(new Event('resize'))
    expect(pageTop()).toBe('332px')
    app.unmount()
    app = null
    expect(height()).toBe('650px')
    expect(pageTop()).toBe('12px')
    document.dispatchEvent(new Event('focusin'))
    document.dispatchEvent(new Event('focusout'))
    viewport.dispatchEvent(new Event('resize'))
    viewport.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(1000)
    expect(height()).toBe('650px')
    expect(pageTop()).toBe('12px')
  })

  it('updates the shell after a standalone resume reports scale 0.912 with matching layout width', () => {
    standaloneTouch()
    vi.stubGlobal('innerWidth', 867)
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(867)
    const viewport = mockViewport({ width: 867, height: 669, offsetTop: 0, offsetLeft: 0 })
    mount()
    expect(height()).toBe('669px')

    // Reproduce the measurements in the device report: a transient portrait
    // height is published before backgrounding, then a smaller viewport returns.
    viewport.height = 596
    window.dispatchEvent(new Event('orientationchange'))
    hidden.mockReturnValue(true)
    document.dispatchEvent(new Event('visibilitychange'))
    Object.assign(viewport, { height: 587, scale: 0.912 })
    viewport.dispatchEvent(new Event('resize'))
    expect(height()).toBe('596px')
    hidden.mockReturnValue(false)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(height()).toBe('587px')
    expect(window.scrollTo).not.toHaveBeenCalled()

    Object.assign(viewport, { height: 669, scale: 1 })
    viewport.dispatchEvent(new Event('resize'))
    expect(height()).toBe('669px')
  })

  it.each(['zoomed width', 'stale layout width', 'panned', 'browser tab'])(
    'preserves the existing height for a sub-unit scale with %s',
    mode => {
      if (mode !== 'browser tab') standaloneTouch()
      vi.stubGlobal('innerWidth', 867)
      const clientWidth = vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(867)
      const viewport = mockViewport({ width: 867, height: 669, offsetTop: 0, offsetLeft: 0 })
      mount()
      Object.assign(viewport, { height: 587, scale: 0.912 })
      if (mode === 'zoomed width') viewport.width = 951
      if (mode === 'stale layout width') clientWidth.mockReturnValue(951)
      if (mode === 'panned') viewport.offsetTop = 20
      window.dispatchEvent(new Event('pageshow'))
      vi.advanceTimersByTime(1000)
      expect(height()).toBe('669px')
      expect(window.scrollTo).not.toHaveBeenCalled()
    }
  )

  it('remeasures on foreground return and again after the viewport settles without a resize event', () => {
    const viewport = mockViewport()
    mount()
    hidden.mockReturnValue(true)
    document.dispatchEvent(new Event('visibilitychange'))
    viewport.height = 400
    viewport.dispatchEvent(new Event('resize'))
    window.dispatchEvent(new Event('resize'))
    vi.advanceTimersByTime(1000)
    expect(height()).toBe('700px')

    hidden.mockReturnValue(false)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(height()).toBe('400px')
    viewport.height = 680
    vi.advanceTimersByTime(250)
    expect(height()).toBe('680px')
    viewport.height = 720
    vi.advanceTimersByTime(500)
    expect(height()).toBe('720px')

    // Recovery is bounded, rather than a permanent polling loop.
    viewport.height = 800
    vi.advanceTimersByTime(10000)
    expect(height()).toBe('720px')
  })

  it.each(['pageshow', 'focus', 'orientationchange'])(
    'recovers a displaced standalone touch document on %s without scrolling its inner pane',
    event => {
      const viewport = mockViewport()
      standaloneTouch()
      mount()
      const pane = document.createElement('div')
      pane.scrollTop = 160
      host.append(pane)
      vi.stubGlobal('scrollY', -84)
      viewport.height = 620

      window.dispatchEvent(new Event(event))
      expect(height()).toBe('620px')
      expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, left: 0, behavior: 'instant' })
      expect(pane.scrollTop).toBe(160)
    }
  )

  it('ignores zero viewport measurements and cancels pending recovery when hidden', () => {
    const viewport = mockViewport()
    mount()
    viewport.height = 0
    window.dispatchEvent(new Event('pageshow'))
    expect(height()).toBe('700px')
    viewport.height = 600
    hidden.mockReturnValue(true)
    document.dispatchEvent(new Event('visibilitychange'))
    vi.advanceTimersByTime(1000)
    expect(height()).toBe('700px')
  })

  it.each(['input', 'textarea', 'contenteditable'])(
    'preserves focus, draft and keyboard panning for a focused %s during recovery',
    type => {
      mockViewport()
      standaloneTouch()
      mount()
      const editable = document.createElement(type === 'contenteditable' ? 'div' : type)
      if (type === 'contenteditable') {
        editable.setAttribute('contenteditable', 'true')
        editable.textContent = 'Unsent reply'
      } else editable.value = 'Unsent reply'
      host.append(editable)
      editable.focus()
      expect(document.activeElement).toBe(editable)
      vi.stubGlobal('scrollY', 84)
      window.dispatchEvent(new Event('pageshow'))
      vi.advanceTimersByTime(1000)

      expect(window.scrollTo).not.toHaveBeenCalled()
      expect(document.activeElement).toBe(editable)
      expect(editable.value || editable.textContent).toBe('Unsent reply')
    }
  )

  it.each(['browser tab', 'desktop PWA', 'pinch zoom'])(
    'does not reset document scrolling in a %s',
    mode => {
      const viewport = mockViewport()
      window.matchMedia.mockImplementation(query => ({
        matches: mode === 'pinch zoom' ||
          (mode === 'browser tab' && query === '(pointer: coarse)') ||
          (mode === 'desktop PWA' && query === '(display-mode: standalone)')
      }))
      mount()
      if (mode === 'pinch zoom') Object.assign(viewport, { scale: 2, height: 350 })
      vi.stubGlobal('scrollY', 84)
      window.dispatchEvent(new Event('pageshow'))
      vi.advanceTimersByTime(1000)

      expect(window.scrollTo).not.toHaveBeenCalled()
      expect(height()).toBe('700px')
    }
  )
})

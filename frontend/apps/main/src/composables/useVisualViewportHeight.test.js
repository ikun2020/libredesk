// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h } from 'vue'
import { useVisualViewportHeight } from './useVisualViewportHeight'

const property = '--visual-viewport-height'
const height = () => document.documentElement.style.getPropertyValue(property)
let app
let host
let hidden

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
      return () => h('div')
    }
  })
  app.mount(host)
}

afterEach(() => {
  app?.unmount()
  app = null
  host?.remove()
  document.documentElement.style.removeProperty(property)
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

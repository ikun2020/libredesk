// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h } from 'vue'
import { useVisualViewportHeight } from './useVisualViewportHeight'

const property = '--visual-viewport-height'
const height = () => document.documentElement.style.getPropertyValue(property)
let app
let host

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
  vi.unstubAllGlobals()
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
    window.dispatchEvent(new Event('resize'))
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
})

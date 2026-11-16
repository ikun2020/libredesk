// @vitest-environment jsdom
import { effectScope } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useIPhoneDuoInbox } from './useIPhoneDuoInbox'

const mediaQuery = '(min-width: 800px) and (max-width: 960px) and (pointer: coarse) and (resolution: 3dppx)'
const standaloneQuery = '(display-mode: standalone)'

function checkLayout({
  wideTouch = true,
  installed = true,
  navigatorStandalone = false,
  userAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X)',
  screen = { width: 466, height: 678 }
} = {}) {
  vi.stubGlobal('navigator', { userAgent, standalone: navigatorStandalone })
  vi.stubGlobal('screen', screen)
  vi.stubGlobal('matchMedia', (query) => Object.assign(new EventTarget(), {
    matches: query === mediaQuery ? wideTouch : query === standaloneQuery && installed
  }))
  const scope = effectScope()
  const enabled = scope.run(useIPhoneDuoInbox).value
  scope.stop()
  return enabled
}

afterEach(() => vi.unstubAllGlobals())

describe('iPhone Duo inbox layout', () => {
  it('matches the standalone Duo viewport with either screen size reported by Safari', () => {
    expect(checkLayout()).toBe(true)
    expect(checkLayout({ screen: { width: 951, height: 669 } })).toBe(true)
    expect(checkLayout({ installed: false, navigatorStandalone: true })).toBe(true)
  })

  it.each([
    ['the outer screen or a narrow window', { wideTouch: false }],
    ['a Safari tab', { installed: false }],
    ['another iPhone screen size', { screen: { width: 430, height: 932 } }],
    ['an iPad with matching dimensions', { userAgent: 'Mozilla/5.0 (iPad)' }]
  ])('leaves the layout alone in %s', (_label, profile) => {
    expect(checkLayout(profile)).toBe(false)
  })
})

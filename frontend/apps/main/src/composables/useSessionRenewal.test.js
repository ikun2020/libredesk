// @vitest-environment jsdom
import { createApp } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionRenewal } from './useSessionRenewal'

const { listen, renewSession, userStore } = vi.hoisted(() => ({
  listen: vi.fn(),
  renewSession: vi.fn(),
  userStore: { userID: 1 }
}))

vi.mock('@vueuse/core', () => ({ useEventListener: listen }))
vi.mock('@main/api', () => ({ default: { renewSession } }))
vi.mock('@main/stores/user', () => ({ useUserStore: () => userStore }))

const renewal = (interval = 60_000) => ({ data: { data: { renew_after_ms: interval } } })
let app
let visibility

const activity = (isTrusted = true) => listen.mock.calls[0][2]({ isTrusted })

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  userStore.userID = 1
  visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  renewSession.mockReset().mockResolvedValue(renewal())
  listen.mockClear()
  app = createApp({
    setup() {
      useSessionRenewal()
      return () => null
    }
  })
  app.mount(document.createElement('div'))
})

afterEach(() => {
  app?.unmount()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('session renewal on activity', () => {
  it('uses actual foreground interaction in the signed-in app', async () => {
    expect(listen).toHaveBeenCalledWith(window, ['pointerdown', 'keydown', 'wheel'], expect.any(Function), {
      capture: true,
      passive: true
    })
    await activity(false)
    visibility.mockReturnValue('hidden')
    await activity()
    visibility.mockReturnValue('visible')
    userStore.userID = null
    await activity()
    expect(renewSession).not.toHaveBeenCalled()

    userStore.userID = 1
    await activity()
    expect(renewSession).toHaveBeenCalledOnce()
  })

  it('coalesces active requests and uses the server-provided cooldown', async () => {
    let resolve
    renewSession.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    const first = activity()
    await activity()
    expect(renewSession).toHaveBeenCalledOnce()

    resolve(renewal(3_000))
    await first
    await vi.advanceTimersByTimeAsync(2_999)
    await activity()
    expect(renewSession).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(renewSession).toHaveBeenCalledOnce()
    await activity()
    expect(renewSession).toHaveBeenCalledTimes(2)
  })

  it('waits for another interaction after a transient error and stops after a 401', async () => {
    renewSession.mockRejectedValueOnce(new Error('offline'))
    renewSession.mockRejectedValueOnce({ response: { status: 401 } })
    await activity()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(renewSession).toHaveBeenCalledOnce()
    await activity()
    expect(renewSession).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(60_000)
    await activity()
    expect(renewSession).toHaveBeenCalledTimes(2)
  })

  it('cancels the active request when leaving the app', async () => {
    renewSession.mockImplementationOnce((signal) => new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve(renewal()))
    }))
    const first = activity()
    app.unmount()
    app = null
    await first
    expect(renewSession.mock.calls[0][0].aborted).toBe(true)
    await activity()
    expect(renewSession).toHaveBeenCalledOnce()
  })
})

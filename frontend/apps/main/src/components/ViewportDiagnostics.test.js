// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'

const { createRecorder } = vi.hoisted(() => ({ createRecorder: vi.fn() }))
vi.mock('@main/utils/viewport-diagnostics', () => ({ createViewportRecorder: createRecorder }))
vi.mock('@main/stores/appSettings', () => ({
  useAppSettingsStore: () => ({ settings: { 'app.version': 'test-version' } })
}))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: key => key }) }))
vi.mock('@shared-ui/components/ui/button', () => ({
  Button: {
    inheritAttrs: false,
    setup (_, { attrs, slots }) {
      return () => h('button', attrs, slots.default?.())
    }
  }
}))

import ViewportDiagnostics from './ViewportDiagnostics.vue'
import { useViewportDiagnostics } from '@main/composables/useViewportDiagnostics'

const controls = useViewportDiagnostics()
const NativeURL = URL
const reportText = '{"schema":1,"samples":[]}'
let app
let host
let recorders
let writeText
let anchorClick

const settle = async () => {
  await nextTick()
  await nextTick()
}

const mount = async () => {
  host = document.createElement('div')
  document.body.append(host)
  app = createApp({ render: () => h(ViewportDiagnostics) })
  app.mount(host)
  await settle()
}

const start = async () => {
  controls.start()
  await settle()
  return recorders.at(-1)
}

const button = key => [...host.querySelectorAll('button')].find(node =>
  node.textContent === key || node.getAttribute('aria-label') === key
)

beforeEach(() => {
  vi.useFakeTimers()
  controls.stop()
  recorders = []
  createRecorder.mockReset().mockImplementation(() => {
    const recorder = {
      start: vi.fn(), stop: vi.fn(), capture: vi.fn(),
      exportReport: vi.fn(() => reportText)
    }
    recorders.push(recorder)
    return recorder
  })
  writeText = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  vi.stubGlobal('fetch', vi.fn())
  class DiagnosticURL extends NativeURL {}
  DiagnosticURL.createObjectURL = vi.fn(() => 'blob:layout-report')
  DiagnosticURL.revokeObjectURL = vi.fn()
  vi.stubGlobal('URL', DiagnosticURL)
  anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
})

afterEach(() => {
  app?.unmount()
  app = undefined
  host?.remove()
  controls.stop()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('viewport diagnostic controls', () => {
  it('starts recording only after explicit activation and exposes report actions', async () => {
    await mount()
    expect(host.querySelector('aside')).toBeNull()
    expect(createRecorder).not.toHaveBeenCalled()
    const recorder = await start()
    expect(createRecorder).toHaveBeenCalledWith({ version: 'test-version' })
    expect(recorder.start).toHaveBeenCalledOnce()
    expect(button('diagnostics.copy')).toBeTruthy()
    expect(button('diagnostics.download')).toBeTruthy()
    expect(writeText).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('captures and writes the report synchronously within the copy click', async () => {
    await mount()
    const recorder = await start()
    let resolveCopy
    writeText.mockImplementation(() => new Promise(resolve => { resolveCopy = resolve }))
    button('diagnostics.copy').click()
    // No tick or await here: Safari needs the clipboard call in the user gesture.
    expect(writeText).toHaveBeenCalledWith(reportText)
    expect(recorder.capture).toHaveBeenCalledWith('export')
    expect(recorder.capture.mock.invocationCallOrder[0]).toBeLessThan(writeText.mock.invocationCallOrder[0])
    expect(host.querySelector('[role="status"]')).toBeNull()
    resolveCopy()
    await settle()
    expect(host.querySelector('[role="status"]').textContent).toBe('diagnostics.copied')
  })

  it('keeps the report available for download if clipboard access is denied', async () => {
    await mount()
    const recorder = await start()
    writeText.mockRejectedValue(new Error('Clipboard denied'))
    button('diagnostics.copy').click()
    await settle()
    expect(host.querySelector('[role="status"]').textContent).toBe('diagnostics.copyFailed')
    expect(controls.active.value).toBe(true)
    expect(recorder.stop).not.toHaveBeenCalled()
    button('diagnostics.download').click()
    expect(URL.createObjectURL).toHaveBeenCalledWith(expect.any(Blob))
    expect(anchorClick).toHaveBeenCalledOnce()
    const link = anchorClick.mock.instances[0]
    expect(link.href).toBe('blob:layout-report')
    expect(link.download).toBe('libredesk-layout-diagnostics.json')
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['stop', 'unmount'])('releases the recorder, download URL and timer on %s', async action => {
    await mount()
    const recorder = await start()
    button('diagnostics.download').click()
    expect(vi.getTimerCount()).toBe(1)
    if (action === 'stop') button('diagnostics.stop').click()
    else {
      app.unmount()
      app = undefined
    }
    await settle()
    expect(recorder.stop).toHaveBeenCalledOnce()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:layout-report')
    expect(vi.getTimerCount()).toBe(0)
    expect(controls.active.value).toBe(false)
    expect(host.querySelector('aside')).toBeNull()
  })

  it('does not show an old clipboard result in a new recording session', async () => {
    await mount()
    await start()
    let resolveCopy
    writeText.mockImplementation(() => new Promise(resolve => { resolveCopy = resolve }))
    button('diagnostics.copy').click()
    button('diagnostics.stop').click()
    await settle()
    const nextRecorder = await start()
    resolveCopy()
    await settle()
    expect(host.querySelector('[role="status"]')).toBeNull()
    expect(nextRecorder.stop).not.toHaveBeenCalled()
    expect(controls.active.value).toBe(true)
  })
})

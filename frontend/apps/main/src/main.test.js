// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { api, settings, router, app, updatePageTitle } = vi.hoisted(() => ({
  api: { getConfig: vi.fn(), getLanguage: vi.fn() },
  settings: { fetchSettings: vi.fn(), setPublicConfig: vi.fn() },
  router: { isReady: vi.fn(), currentRoute: { value: { name: 'inbox' } } },
  app: { use: vi.fn(), mount: vi.fn(), config: { globalProperties: {} } },
  updatePageTitle: vi.fn()
}))

vi.mock('./api', () => ({ default: api }))
vi.mock('./stores/appSettings', () => ({ useAppSettingsStore: () => settings }))
vi.mock('./router', () => ({ default: router, updatePageTitle }))
vi.mock('./Root.vue', () => ({ default: {} }))
vi.mock('vue', () => ({ createApp: () => app }))
vi.mock('pinia', () => ({ createPinia: () => ({}) }))
vi.mock('./i18n', () => ({ initI18n: vi.fn() }))

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  document.body.innerHTML = '<div id="app-startup"></div><div id="app"></div>'
  api.getConfig.mockResolvedValue({ data: { data: { 'app.lang': 'zh-CN' } } })
  api.getLanguage.mockResolvedValue({ data: {} })
})

afterEach(() => {
  vi.restoreAllMocks()
})

it('starts loading the route before configuration and keeps startup visible until both complete', async () => {
  const publicConfig = Promise.withResolvers()
  const generalSettings = Promise.withResolvers()
  const initialRoute = Promise.withResolvers()
  api.getConfig.mockReturnValue(publicConfig.promise)
  settings.fetchSettings.mockReturnValue(generalSettings.promise)
  router.isReady.mockReturnValue(initialRoute.promise)

  await import('./main.js')
  expect(settings.fetchSettings).toHaveBeenCalledWith('general')
  expect(router.isReady).toHaveBeenCalled()
  expect(api.getLanguage).not.toHaveBeenCalled()

  publicConfig.resolve({ data: { data: { 'app.lang': 'zh-CN' } } })
  await vi.waitFor(() => expect(api.getLanguage).toHaveBeenCalledWith('zh-CN'))
  expect(app.mount).not.toHaveBeenCalled()
  expect(document.getElementById('app-startup')).not.toBeNull()

  generalSettings.resolve({})
  expect(app.mount).not.toHaveBeenCalled()
  expect(document.getElementById('app-startup')).not.toBeNull()

  initialRoute.resolve()
  await vi.waitFor(() => expect(app.mount).toHaveBeenCalledWith('#app'))
  expect(updatePageTitle).toHaveBeenCalledWith(router.currentRoute.value)
  expect(document.getElementById('app-startup')).toBeNull()
})

it.each(['configuration', 'route'])('shows a retry state when the initial %s fails', async (step) => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const error = new Error('offline')
  if (step === 'configuration') {
    api.getConfig.mockRejectedValue(error)
  } else {
    router.isReady.mockRejectedValue(error)
  }

  await import('./main.js')
  await vi.waitFor(() => expect(document.getElementById('app-startup').hasAttribute('data-startup-error')).toBe(true))
  expect(app.mount).not.toHaveBeenCalled()
})

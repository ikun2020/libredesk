// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { api, settings, router, app } = vi.hoisted(() => ({
  api: { getConfig: vi.fn(), getLanguage: vi.fn() },
  settings: { fetchSettings: vi.fn(), setPublicConfig: vi.fn() },
  router: { isReady: vi.fn() },
  app: { use: vi.fn(), mount: vi.fn(), config: { globalProperties: {} } }
}))

vi.mock('./api', () => ({ default: api }))
vi.mock('./stores/appSettings', () => ({ useAppSettingsStore: () => settings }))
vi.mock('./router', () => ({ default: router }))
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

it('loads settings in parallel and keeps the startup screen until the first route is mounted', async () => {
  const generalSettings = Promise.withResolvers()
  const initialRoute = Promise.withResolvers()
  settings.fetchSettings.mockReturnValue(generalSettings.promise)
  router.isReady.mockReturnValue(initialRoute.promise)

  await import('./main.js')
  expect(settings.fetchSettings).toHaveBeenCalledWith('general')
  await vi.waitFor(() => expect(api.getLanguage).toHaveBeenCalledWith('zh-CN'))
  expect(app.mount).not.toHaveBeenCalled()
  expect(document.getElementById('app-startup')).not.toBeNull()

  generalSettings.resolve({})
  await vi.waitFor(() => expect(router.isReady).toHaveBeenCalled())
  expect(app.mount).not.toHaveBeenCalled()
  expect(document.getElementById('app-startup')).not.toBeNull()

  initialRoute.resolve()
  await vi.waitFor(() => expect(app.mount).toHaveBeenCalledWith('#app'))
  expect(document.getElementById('app-startup')).toBeNull()
})

it('shows a retry state when startup fails', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  api.getConfig.mockRejectedValue(new Error('offline'))

  await import('./main.js')
  await vi.waitFor(() => expect(document.getElementById('app-startup').hasAttribute('data-startup-error')).toBe(true))
  expect(app.mount).not.toHaveBeenCalled()
})

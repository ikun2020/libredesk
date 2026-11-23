// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { api, settings, router, app, updatePageTitle, initI18n } = vi.hoisted(() => ({
  api: { getConfig: vi.fn(), getLanguage: vi.fn() },
  settings: { fetchSettings: vi.fn(), setPublicConfig: vi.fn() },
  router: { isReady: vi.fn(), currentRoute: { value: { name: 'inbox' } } },
  app: { use: vi.fn(), mount: vi.fn(), config: { globalProperties: {} } },
  updatePageTitle: vi.fn(),
  initI18n: vi.fn()
}))

vi.mock('./api', () => ({ default: api }))
vi.mock('./stores/appSettings', () => ({ useAppSettingsStore: () => settings }))
vi.mock('./router', () => ({ default: router, updatePageTitle }))
vi.mock('./Root.vue', () => ({ default: {} }))
vi.mock('vue', () => ({ createApp: () => app }))
vi.mock('pinia', () => ({ createPinia: () => ({}) }))
vi.mock('./i18n', () => ({ initI18n }))

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

it('loads the first route alongside the public config and mounts before general settings finish', async () => {
  const publicConfig = Promise.withResolvers()
  const generalSettings = Promise.withResolvers()
  const initialRoute = Promise.withResolvers()
  api.getConfig.mockReturnValue(publicConfig.promise)
  settings.fetchSettings.mockReturnValue(generalSettings.promise)
  router.isReady.mockReturnValue(initialRoute.promise)

  await import('./main.js')
  expect(settings.fetchSettings).toHaveBeenCalledWith('general')
  expect(api.getConfig).toHaveBeenCalledWith({ include_language: true })
  expect(router.isReady).toHaveBeenCalled()
  expect(app.mount).not.toHaveBeenCalled()
  expect(document.getElementById('app-startup')).not.toBeNull()

  const messages = { welcome: '你好' }
  publicConfig.resolve({ data: { data: { 'app.lang': 'zh-CN', 'app.lang_messages': messages } } })
  await vi.waitFor(() => expect(initI18n).toHaveBeenCalledWith(expect.objectContaining({
    locale: 'zh-CN', messages: { 'zh-CN': messages }
  })))
  expect(settings.setPublicConfig).toHaveBeenCalledWith({ 'app.lang': 'zh-CN' })
  expect(api.getLanguage).not.toHaveBeenCalled()
  expect(app.mount).not.toHaveBeenCalled()
  expect(document.getElementById('app-startup')).not.toBeNull()

  initialRoute.resolve()
  await vi.waitFor(() => expect(app.mount).toHaveBeenCalledWith('#app'))
  expect(updatePageTitle).toHaveBeenCalledWith(router.currentRoute.value)
  expect(document.getElementById('app-startup')).toBeNull()
  generalSettings.resolve({})
})

it('requests the language separately when the public config has no translations', async () => {
  const messages = { welcome: '你好' }
  api.getLanguage.mockResolvedValueOnce({ data: messages })
  await import('./main.js')
  await vi.waitFor(() => expect(app.mount).toHaveBeenCalledWith('#app'))
  expect(api.getLanguage).toHaveBeenCalledExactlyOnceWith('zh-CN')
  expect(initI18n).toHaveBeenCalledWith(expect.objectContaining({ messages: { 'zh-CN': messages } }))
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

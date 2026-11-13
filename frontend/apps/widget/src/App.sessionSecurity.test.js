// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createApp, nextTick, reactive } from 'vue'

const api = vi.hoisted(() => ({ exchangeJWTForSession: vi.fn(), getAuthMe: vi.fn() }))
const saveSession = vi.hoisted(() => vi.fn())
const usesSecureIntegration = vi.hoisted(() => vi.fn(() => true))
const widget = reactive({ config: {}, isDark: false, branding: {}, currentView: 'chat' })
const user = reactive({ userSessionToken: 'old-session', isVisitor: false })
const chat = reactive({ drafts: {}, conversations: [], currentConversation: null })
const help = reactive({ reset: vi.fn(), load: vi.fn() })
const proactive = reactive({ reset: vi.fn(), setSessionKey: vi.fn(), setBrowserKey: vi.fn() })

vi.mock('@widget/api/index.js', () => ({ default: api, saveSession, usesSecureIntegration, setApiSessionToken: vi.fn(), initVisitorToken: vi.fn(), registerStores: vi.fn() }))
vi.mock('@widget/store/widget.js', () => ({ useWidgetStore: () => widget }))
vi.mock('@widget/store/chat.js', () => ({ useChatStore: () => chat }))
vi.mock('@widget/store/user.js', () => ({ useUserStore: () => user }))
vi.mock('@widget/store/help.js', () => ({ useHelpStore: () => help }))
vi.mock('@widget/store/proactive.js', () => ({ useProactiveStore: () => proactive }))
vi.mock('@widget/websocket.js', () => ({ initWidgetWS: vi.fn(), closeWidgetWebSocket: vi.fn(), sendPageVisit: vi.fn(), skipInitialWsSync: vi.fn() }))
vi.mock('@widget/composables/useUnreadCount.js', () => ({ useUnreadCount: vi.fn() }))
vi.mock('@widget/composables/useReplyPreviews.js', () => ({ useReplyPreviews: vi.fn() }))
vi.mock('@shared-ui/composables/useNotificationSound.js', () => ({ initAudioContext: vi.fn() }))
vi.mock('@widget/layouts/MainLayout.vue', () => ({ default: { template: '<div>chat</div>' } }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ locale: { value: 'en' }, setLocaleMessage: vi.fn() }) }))

import App from './App.vue'

let app, host, parent, originalParent, listeners
const settle = async () => { for (let i = 0; i < 12; i++) await nextTick() }
const response = () => ({ data: { data: { protocol: 1, session_token: 'renewed-session', user: { user_id: 42, is_visitor: false } } } })
const message = async (type, extra = {}, origin = 'https://panel.example.test') => {
  window.dispatchEvent(new MessageEvent('message', { source: parent, origin, data: { type, ...extra } }))
  await settle()
}

beforeEach(async () => {
  vi.clearAllMocks()
  api.exchangeJWTForSession.mockReset().mockResolvedValue(response())
  usesSecureIntegration.mockReturnValue(true)
  Object.assign(chat, {
    drafts: { thread: '尚未发送的正文' }, preChatDraft: { message: 'first draft' }, handoffDraft: {},
    conversations: [{ uuid: 'thread' }], currentConversation: { uuid: 'thread' },
    fetchConversations: vi.fn().mockResolvedValue(true), loadConversation: vi.fn().mockResolvedValue(true),
    setCurrentConversation: vi.fn(value => { chat.currentConversation = value })
  })
  Object.assign(widget, { config: {}, currentView: 'chat', navigateToHome: vi.fn(), navigateToChat: vi.fn() })
  user.userSessionToken = 'old-session'
  user.clearSessionToken = vi.fn(() => { user.userSessionToken = '' })
  saveSession.mockImplementation(token => { user.userSessionToken = token })
  originalParent = Object.getOwnPropertyDescriptor(window, 'parent')
  parent = { postMessage: vi.fn() }
  Object.defineProperty(window, 'parent', { configurable: true, value: parent })
  window.history.replaceState({}, '', '/widget?integration=1&parent_origin=https%3A%2F%2Fpanel.example.test&inbox_id=inbox')
  listeners = vi.spyOn(window, 'addEventListener')
  host = document.createElement('div')
  document.body.append(host)
  app = createApp(App)
  app.mount(host)
  await settle()
  parent.postMessage.mockClear()
})

afterEach(() => {
  for (const [type, listener] of listeners.mock.calls) if (type === 'message') window.removeEventListener(type, listener)
  app.unmount()
  host.remove()
  Object.defineProperty(window, 'parent', originalParent)
  vi.restoreAllMocks()
})

test('a refreshed lease preserves the active conversation, view and unsent draft', async () => {
  const drafts = chat.drafts
  await message('REFRESH_JWT_TOKEN', { jwt: 'renewal.jwt' })
  expect(saveSession).toHaveBeenCalledWith('renewed-session', expect.objectContaining({ user_id: 42 }), user)
  expect(chat.drafts).toBe(drafts)
  expect(chat.drafts.thread).toBe('尚未发送的正文')
  expect(chat.currentConversation.uuid).toBe('thread')
  expect(widget.currentView).toBe('chat')
  expect(proactive.reset).not.toHaveBeenCalled()
  expect(chat.loadConversation).toHaveBeenCalledWith('thread', true, true)
})

test('late renewal cannot restore the session after CLEAR_SESSION', async () => {
  let resolve
  api.exchangeJWTForSession.mockReturnValue(new Promise(done => { resolve = done }))
  await message('REFRESH_JWT_TOKEN', { jwt: 'renewal.jwt' })
  await message('CLEAR_SESSION')
  resolve(response())
  await settle()
  expect(saveSession).not.toHaveBeenCalled()
  expect(user.userSessionToken).toBe('')
  expect(chat.currentConversation).toBeNull()
})

test('a different origin cannot renew or replace the identity', async () => {
  await message('REFRESH_JWT_TOKEN', { jwt: 'attacker.jwt' }, 'https://attacker.example.test')
  expect(api.exchangeJWTForSession).not.toHaveBeenCalled()
  expect(user.userSessionToken).toBe('old-session')
})

test('failed identity exchange emits no credential-bearing error object or anonymous-ready signal', async () => {
  const logger = vi.spyOn(console, 'error').mockImplementation(() => {})
  api.exchangeJWTForSession.mockRejectedValue({ config: { data: { jwt: 'private.jwt' } } })
  await message('REFRESH_JWT_TOKEN', { jwt: 'private.jwt' })
  expect(logger).toHaveBeenCalledExactlyOnceWith('Failed to exchange JWT for session')
  expect(parent.postMessage).toHaveBeenCalledWith({ type: 'REFRESH_AUTH_SESSION' }, 'https://panel.example.test')
  expect(parent.postMessage.mock.calls.some(([value]) => value.type === 'WIDGET_LOADED')).toBe(false)
  expect(chat.drafts.thread).toBe('尚未发送的正文')
})

test('normal identity replacement still clears the former user draft', async () => {
  await message('SET_JWT_TOKEN', { jwt: 'new-user.jwt' })
  expect(chat.drafts).toEqual({})
  expect(chat.preChatDraft).toEqual({})
  expect(chat.setCurrentConversation).toHaveBeenCalledWith(null)
})

test('legacy widgets do not accept the integration-only refresh message', async () => {
  usesSecureIntegration.mockReturnValue(false)
  await message('REFRESH_JWT_TOKEN', { jwt: 'unexpected.jwt' })
  expect(api.exchangeJWTForSession).not.toHaveBeenCalled()
})

test.each(['SET_JWT_TOKEN', 'REFRESH_JWT_TOKEN'])('secure %s refuses a server response without the bounded-session protocol', async type => {
  const legacy = response()
  delete legacy.data.data.protocol
  api.exchangeJWTForSession.mockResolvedValue(legacy)
  await message(type, { jwt: 'identity.jwt' })
  expect(saveSession).not.toHaveBeenCalled()
  expect(parent.postMessage).toHaveBeenCalledWith({ type: 'SECURE_AUTH_UNAVAILABLE' }, 'https://panel.example.test')
})

// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createApp, nextTick, reactive } from 'vue'

const api = vi.hoisted(() => ({ exchangeJWTForSession: vi.fn(), getAuthMe: vi.fn() }))
const saveSession = vi.hoisted(() => vi.fn())
const usesVisitorProfileIntegration = vi.hoisted(() => vi.fn(() => false))
const setVisitorProfile = vi.hoisted(() => vi.fn())
const clearVisitorProfile = vi.hoisted(() => vi.fn())
const flushVisitorProfile = vi.hoisted(() => vi.fn())
const widget = reactive({ config: {}, isDark: false, branding: {}, currentView: 'chat' })
const user = reactive({ userSessionToken: 'old-session', isVisitor: false })
const chat = reactive({ drafts: {}, conversations: [], currentConversation: null })
const help = reactive({ reset: vi.fn(), load: vi.fn() })
const proactive = reactive({ reset: vi.fn(), setSessionKey: vi.fn(), setBrowserKey: vi.fn() })

vi.mock('@widget/api/index.js', () => ({ default: api, saveSession, usesVisitorProfileIntegration,
  setVisitorProfile, clearVisitorProfile, flushVisitorProfile,
  setApiSessionToken: vi.fn(), initVisitorToken: vi.fn(), registerStores: vi.fn() }))
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
const response = () => ({ data: { data: { session_token: 'authenticated-session', user: { user_id: 42, is_visitor: false } } } })
const message = async (type, extra = {}, origin = 'https://panel.example.test') => {
  window.dispatchEvent(new MessageEvent('message', { source: parent, origin, data: { type, ...extra } }))
  await settle()
}

beforeEach(async () => {
  vi.clearAllMocks()
  api.exchangeJWTForSession.mockReset().mockResolvedValue(response())
  usesVisitorProfileIntegration.mockReturnValue(false)
  Object.assign(chat, {
    drafts: { thread: '尚未发送的正文' }, preChatDraft: { message: 'first draft' }, handoffDraft: {},
    conversations: [{ uuid: 'thread' }], currentConversation: { uuid: 'thread' },
    hasConversations: false, getConversations: [], supportSyncConversation: null,
    fetchConversations: vi.fn().mockResolvedValue(true), loadConversation: vi.fn().mockResolvedValue(true),
    setCurrentConversation: vi.fn(value => { chat.currentConversation = value })
  })
  Object.assign(widget, { config: {}, currentView: 'chat', navigateToHome: vi.fn(), navigateToChat: vi.fn() })
  user.userSessionToken = 'old-session'
  user.userID = null
  user.isVisitor = false
  user.setSessionToken = vi.fn(token => { user.userSessionToken = token })
  user.setUserMeta = vi.fn(meta => { user.userID = meta.user_id; user.isVisitor = meta.is_visitor })
  user.clearSessionToken = vi.fn(() => { user.userSessionToken = '' })
  saveSession.mockImplementation(token => { user.userSessionToken = token })
  originalParent = Object.getOwnPropertyDescriptor(window, 'parent')
  parent = { postMessage: vi.fn() }
  Object.defineProperty(window, 'parent', { configurable: true, value: parent })
  window.history.replaceState({}, '', '/widget?parent_origin=https%3A%2F%2Fpanel.example.test&inbox_id=inbox')
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

test('a late identity exchange cannot restore the session after CLEAR_SESSION', async () => {
  let resolve
  api.exchangeJWTForSession.mockReturnValue(new Promise(done => { resolve = done }))
  await message('SET_JWT_TOKEN', { jwt: 'identity.jwt' })
  await message('CLEAR_SESSION')
  resolve(response())
  await settle()
  expect(saveSession).not.toHaveBeenCalled()
  expect(user.userSessionToken).toBe('')
  expect(chat.currentConversation).toBeNull()
})

test('a different origin cannot replace the identity', async () => {
  await message('SET_JWT_TOKEN', { jwt: 'attacker.jwt' }, 'https://attacker.example.test')
  expect(api.exchangeJWTForSession).not.toHaveBeenCalled()
  expect(user.userSessionToken).toBe('old-session')
})

test('failed identity exchange emits no credential-bearing error object', async () => {
  const logger = vi.spyOn(console, 'error').mockImplementation(() => {})
  api.exchangeJWTForSession.mockRejectedValue({ config: { data: { jwt: 'private.jwt' } } })
  await message('SET_JWT_TOKEN', { jwt: 'private.jwt' })
  expect(logger).toHaveBeenCalledExactlyOnceWith('Failed to exchange JWT for session')
  expect(saveSession).not.toHaveBeenCalled()
})

test('normal identity replacement still clears the former user draft', async () => {
  await message('SET_JWT_TOKEN', { jwt: 'new-user.jwt' })
  expect(saveSession).toHaveBeenCalledWith('authenticated-session', expect.objectContaining({ user_id: 42 }), user)
  expect(chat.drafts).toEqual({})
  expect(chat.preChatDraft).toEqual({})
  expect(chat.setCurrentConversation).toHaveBeenCalledWith(null)
})

test('only a lite iframe accepts a profile from its exact parent origin', async () => {
  const profile = { email: 'user@example.test', contact_custom_attributes: { xboard_plan: 'Basic' } }
  await message('SET_VISITOR_PROFILE', { profile })
  expect(setVisitorProfile).not.toHaveBeenCalled()
  usesVisitorProfileIntegration.mockReturnValue(true)
  await message('SET_VISITOR_PROFILE', { profile }, 'https://attacker.example.test')
  expect(setVisitorProfile).not.toHaveBeenCalled()
  const drafts = chat.drafts
  await message('SET_VISITOR_PROFILE', { profile })
  expect(setVisitorProfile).toHaveBeenCalledExactlyOnceWith(profile)
  expect(chat.drafts).toBe(drafts)
  expect(api.exchangeJWTForSession).not.toHaveBeenCalled()
})

test('clearing or upgrading identity discards unsigned reference data', async () => {
  await message('CLEAR_SESSION')
  expect(clearVisitorProfile).toHaveBeenCalledOnce()
  await message('SET_JWT_TOKEN', { jwt: 'new-user.jwt' })
  expect(clearVisitorProfile).toHaveBeenCalledTimes(2)
})

const signedMode = () => window.history.replaceState({}, '', window.location.href + '&integration=support-sync')
const signedResponse = (userID = 42) => ({
  data: { data: { identity_provider: 'support-sync', session_token: 'signed-session', user: { user_id: userID, is_visitor: false } } }
})

test('Support Sync rejects exchanges without the strict server marker', async () => {
  signedMode()
  await message('SUPPORT_SYNC_AUTH', { jwt: 'signed.jwt' })
  expect(user.setSessionToken).not.toHaveBeenCalled()
  expect(parent.postMessage).toHaveBeenCalledWith({ type: 'SUPPORT_SYNC_RESULT', ok: false }, 'https://panel.example.test')
  expect(parent.postMessage.mock.calls.some(([event]) => event.type === 'WIDGET_LOADED')).toBe(false)
})

test('Support Sync waits for history but becomes ready while the help center is still loading', async () => {
  signedMode()
  widget.config.help = { help_center_id: 1 }
  api.exchangeJWTForSession.mockResolvedValue(signedResponse())
  let finishHistory
  let finishHelp
  chat.fetchConversations.mockReturnValueOnce(new Promise(resolve => { finishHistory = resolve }))
  help.load.mockReturnValueOnce(new Promise(resolve => { finishHelp = resolve }))

  await message('SUPPORT_SYNC_AUTH', { jwt: 'signed.jwt' })
  expect(parent.postMessage).not.toHaveBeenCalled()
  expect(help.load).not.toHaveBeenCalled()

  finishHistory(true)
  await settle()
  expect(help.load).toHaveBeenCalledOnce()
  expect(parent.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'WIDGET_LOADED' }), '*')
  expect(parent.postMessage).toHaveBeenCalledWith({ type: 'SUPPORT_SYNC_RESULT', ok: true }, 'https://panel.example.test')
  finishHelp()
})

test('Support Sync restores history and updates profile without exposing the session or clearing drafts', async () => {
  signedMode()
  api.exchangeJWTForSession.mockResolvedValue(signedResponse())
  await message('SUPPORT_SYNC_AUTH', { jwt: 'signed.jwt', visitorToken: 'prior-visitor' })
  expect(user.userID).toBe(42)
  expect(user.setUserMeta).toHaveBeenCalledWith(expect.objectContaining({ user_id: 42 }), 'support-sync')
  expect(chat.fetchConversations).toHaveBeenCalledOnce()
  expect(parent.postMessage).toHaveBeenCalledWith({ type: 'SUPPORT_SYNC_RESULT', ok: true }, 'https://panel.example.test')
  expect(saveSession).not.toHaveBeenCalled()
  const drafts = chat.drafts
  await message('SUPPORT_SYNC_PROFILE', { jwt: 'refresh.jwt' })
  expect(chat.fetchConversations).toHaveBeenCalledOnce()
  expect(chat.drafts).toBe(drafts)
  api.exchangeJWTForSession.mockResolvedValue(signedResponse(99))
  await message('SUPPORT_SYNC_PROFILE', { jwt: 'different.jwt' })
  expect(user.userID).toBe(42)
  expect(parent.postMessage).toHaveBeenLastCalledWith({ type: 'SUPPORT_SYNC_RESULT', ok: false }, 'https://panel.example.test')
})

test('verified Support Sync opens the ongoing thread even when newer resolved history exists', async () => {
  signedMode()
  api.exchangeJWTForSession.mockResolvedValue(signedResponse())
  const ongoing = { uuid: 'ongoing', status_category: 'open' }
  chat.hasConversations = true
  chat.getConversations = [{ uuid: 'resolved', status_category: 'resolved' }, ongoing]
  chat.supportSyncConversation = ongoing
  await message('SUPPORT_SYNC_AUTH', { jwt: 'signed.jwt' })
  expect(chat.loadConversation).toHaveBeenCalledExactlyOnceWith('ongoing')
  expect(widget.navigateToChat).toHaveBeenCalledOnce()
  expect(chat.getConversations.map(({ uuid }) => uuid)).toEqual(['resolved', 'ongoing'])
})

test('Support Sync does not enter an empty chat when the ongoing conversation fails to load', async () => {
  signedMode()
  api.exchangeJWTForSession.mockResolvedValue(signedResponse())
  const ongoing = { uuid: 'ongoing', status_category: 'open' }
  chat.hasConversations = true
  chat.getConversations = [ongoing]
  chat.supportSyncConversation = ongoing
  chat.loadConversation.mockResolvedValueOnce(false)
  widget.config.users = { direct_to_conversation: true }
  await message('SUPPORT_SYNC_AUTH', { jwt: 'signed.jwt' })
  expect(chat.loadConversation).toHaveBeenCalledExactlyOnceWith('ongoing')
  expect(widget.navigateToChat).not.toHaveBeenCalled()
})

// @vitest-environment jsdom
import axios, { AxiosError } from 'axios'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

let originalParent
let originalAdapter
let parent
let client
let stores
let sentHeaders

beforeEach(async () => {
  vi.resetModules()
  originalParent = Object.getOwnPropertyDescriptor(window, 'parent')
  originalAdapter = axios.defaults.adapter
  parent = { postMessage: vi.fn() }
  Object.defineProperty(window, 'parent', { configurable: true, value: parent })
  window.history.replaceState({}, '', '/widget?parent_origin=https%3A%2F%2Fpanel.example.test')
  axios.defaults.adapter = async config => {
    sentHeaders = { ...config.headers }
    const response = { status: 401, data: {}, headers: {}, config }
    throw new AxiosError('Unauthorized', 'ERR_BAD_REQUEST', config, null, response)
  }
  // resetModules creates a fresh axios module; configure that instance too.
  const freshAxios = (await import('axios')).default
  freshAxios.defaults.adapter = axios.defaults.adapter
  client = await import('./index.js')
  stores = {
    userStore: { clearSessionToken: vi.fn() },
    chatStore: { drafts: { thread: 'unsent text' }, conversations: [{ uuid: 'thread' }], setCurrentConversation: vi.fn() },
    widgetStore: { closeWidget: vi.fn() }
  }
  client.registerStores(stores)
  client.setApiSessionToken('private-session')
})

afterEach(() => {
  Object.defineProperty(window, 'parent', originalParent)
  axios.defaults.adapter = originalAdapter
  vi.restoreAllMocks()
})

test.each(['', 'lite'])('embedded widgets retain their existing expiry behavior (integration=%s)', async integration => {
  window.history.replaceState({}, '', `/widget?integration=${integration}&parent_origin=https%3A%2F%2Fpanel.example.test`)
  await expect(client.default.getAuthMe()).rejects.toBeDefined()
  expect(stores.userStore.clearSessionToken).toHaveBeenCalledOnce()
  expect(stores.widgetStore.closeWidget).toHaveBeenCalledOnce()
  expect(stores.chatStore.conversations).toBeNull()
})

test('errors returned to callers cannot include the JWT request or bearer headers', async () => {
  let failure
  try { await client.default.exchangeJWTForSession('private.jwt.value') } catch (error) { failure = error }
  expect(failure.config.data).toBe('[redacted]')
  expect(failure.config.headers.Authorization).toBeUndefined()
  const serialized = JSON.stringify(failure.toJSON())
  expect(serialized).not.toContain('private.jwt.value')
  expect(serialized).not.toContain('private-session')
})

test('a pending identity only travels to its supported paths and is redacted on errors', async () => {
  client.setApiSessionToken('')
  client.setPendingSupportSyncIdentity('sealed-private-identity')
  await expect(client.default.getChatConversations()).rejects.toBeDefined()
  expect(sentHeaders['X-Libredesk-Pending-Identity']).toBeUndefined()
  expect(stores.userStore.clearSessionToken).not.toHaveBeenCalled()

  let failure
  try { await client.default.initChatConversation({ message: 'Hello' }) } catch (error) { failure = error }
  expect(sentHeaders['X-Libredesk-Pending-Identity']).toBe('sealed-private-identity')
  expect(failure.config.headers['X-Libredesk-Pending-Identity']).toBeUndefined()
  expect(JSON.stringify(failure.toJSON())).not.toContain('sealed-private-identity')
  expect(stores.userStore.clearSessionToken).toHaveBeenCalledOnce()
})

test('installing a first signed session clears pending state without posting credentials to the host', () => {
  const store = { setSessionToken: vi.fn(), setUserMeta: vi.fn() }
  const user = { user_id: 14, is_visitor: false }
  client.setPendingSupportSyncIdentity('sealed-private-identity')
  client.saveSupportSyncSession('verified-session', user, store)
  expect(store.setSessionToken).toHaveBeenCalledWith('verified-session')
  expect(store.setUserMeta).toHaveBeenCalledWith(user, 'support-sync')
  expect(client.hasPendingSupportSyncIdentity()).toBe(false)
  expect(parent.postMessage).not.toHaveBeenCalled()
})

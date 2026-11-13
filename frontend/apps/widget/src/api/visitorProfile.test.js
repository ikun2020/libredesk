// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

let client, stores, requests, originalParent
const profile = { email: 'person@example.test', contact_custom_attributes: { xboard_plan: 'Plan A' } }

beforeEach(async () => {
  vi.resetModules()
  originalParent = Object.getOwnPropertyDescriptor(window, 'parent')
  Object.defineProperty(window, 'parent', { configurable: true, value: { postMessage: vi.fn() } })
  window.history.replaceState({}, '', '/widget?integration=lite&parent_origin=https%3A%2F%2Fpanel.example.test&inbox_id=inbox')
  requests = []
  const axios = (await import('axios')).default
  axios.defaults.adapter = async config => {
    requests.push(config)
    return { status: 200, headers: {}, config, data: { data: true } }
  }
  client = await import('./index.js')
  stores = { userStore: { isVisitor: true, setSessionToken: vi.fn(), setUserMeta: vi.fn() } }
  client.registerStores(stores)
})

afterEach(() => {
  client.clearVisitorProfile()
  Object.defineProperty(window, 'parent', originalParent)
  vi.restoreAllMocks()
})

test('unsigned profile is sent only with the first real chat, including attachment initialization', async () => {
  client.setVisitorProfile(profile)
  await client.flushVisitorProfile()
  expect(requests).toHaveLength(0)
  await client.default.initChatConversation({ message: 'Hello' })
  expect(JSON.parse(requests[0].data)).toEqual({ message: 'Hello', visitor_profile: profile })
  await client.default.initChatConversation({ message: '' }, [new File(['data'], 'photo.png', { type: 'image/png' })])
  expect(JSON.parse(requests[1].data.get('payload'))).toEqual({ message: '', visitor_profile: profile })
})

test('subsequent refresh updates only the token-authorized visitor without merge headers', async () => {
  client.initVisitorToken('unrelated-visitor')
  client.setApiSessionToken('current-visitor')
  client.setVisitorProfile(profile)
  await client.flushVisitorProfile()
  expect(requests).toHaveLength(1)
  expect(requests[0].url).toBe('/api/v1/widget/chat/visitor/profile')
  expect(requests[0].headers.Authorization).toBe('Bearer current-visitor')
  expect(requests[0].headers['X-Libredesk-Visitor-Token']).toBeUndefined()
  expect(JSON.parse(requests[0].data)).toEqual(profile)
})

test('a new session flushes the latest cached data after a real first message', async () => {
  client.setVisitorProfile(profile)
  client.saveSession('new-visitor', { is_visitor: true }, stores.userStore, true)
  await client.flushVisitorProfile()
  expect(requests).toHaveLength(1)
  expect(requests[0].headers.Authorization).toBe('Bearer new-visitor')
})

test('verified mode and verified contacts never receive unsigned profiles', async () => {
  window.history.replaceState({}, '', '/widget?integration=1')
  expect(client.setVisitorProfile(profile)).toBe(false)
  await client.default.initChatConversation({ message: 'signed' })
  expect(JSON.parse(requests[0].data)).toEqual({ message: 'signed' })
  window.history.replaceState({}, '', '/widget?integration=lite')
  stores.userStore.isVisitor = false
  client.setApiSessionToken('verified-contact')
  client.setVisitorProfile(profile)
  await client.flushVisitorProfile()
  await client.default.initChatConversation({ message: 'contact' })
  expect(requests).toHaveLength(2)
  expect(JSON.parse(requests[1].data)).toEqual({ message: 'contact' })
})

test('cleared profiles cannot leak into the following anonymous chat', async () => {
  client.setVisitorProfile(profile)
  client.clearVisitorProfile()
  await client.default.initChatConversation({ message: 'next visitor' })
  expect(JSON.parse(requests[0].data)).toEqual({ message: 'next visitor' })
})

test('campaign initialization keeps its existing payload and syncs after session creation', async () => {
  client.setVisitorProfile(profile)
  await client.default.initChatConversation({ message: 'Reply to invitation', delivery_id: 'delivery' })
  expect(JSON.parse(requests[0].data)).toEqual({ message: 'Reply to invitation', delivery_id: 'delivery' })
  client.saveSession('campaign-visitor', { is_visitor: true }, stores.userStore, true)
  await client.flushVisitorProfile()
  expect(requests[1].url).toBe('/api/v1/widget/chat/visitor/profile')
})

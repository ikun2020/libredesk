// @vitest-environment jsdom
import { beforeEach, expect, test, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import api from '@widget/api/index.js'
import { useChatStore } from './chat.js'
import { useUserStore } from './user.js'

vi.mock('@widget/api/index.js', () => ({
  default: { getChatConversation: vi.fn() },
  setApiSessionToken: vi.fn()
}))

const conversationUUID = 'conversation'
const first = '2026-11-17T10:00:00Z'
const second = '2026-11-17T10:01:00Z'
const edited = '2026-11-17T10:02:00.000123Z'
const outdated = '2026-11-17T10:02:00.000122Z'
const message = (uuid, created_at) => ({
  uuid, created_at, content: uuid, content_type: 'text', text_content: uuid,
  author: { id: 1, type: 'agent' }
})
const conversationResponse = (messages) => ({
  data: { data: { conversation: { uuid: conversationUUID }, messages } }
})

let chat, original, latest
beforeEach(() => {
  vi.clearAllMocks()
  setActivePinia(createPinia())
  chat = useChatStore()
  useUserStore().setSessionToken('session')
  original = message('original', first)
  latest = message('latest', second)
  chat.setCurrentConversation({ uuid: conversationUUID })
  chat.replaceMessages([original, latest])
  chat.conversations = [{
    uuid: conversationUUID,
    last_message: latest,
    unread_message_count: 2,
    unread_messages: [latest, original]
  }]
})

test('edits the existing bubble and unread preview without moving the message or adding unread', () => {
  const update = {
    conversation_uuid: conversationUUID,
    uuid: original.uuid,
    content: 'new text',
    text_content: 'new text',
    content_type: 'text',
    updated_at: edited,
    edited_at: edited,
    conversation_last_message: latest,
    unread_message_count: 2
  }
  chat.applyMessageUpdate(update)
  chat.applyMessageUpdate({ ...update, content: 'stale text', updated_at: outdated, edited_at: outdated })

  expect(chat.getCurrentConversationMessages.map(({ content }) => content)).toEqual(['new text', 'latest'])
  expect(chat.getCurrentConversationMessages[0].edited_at).toBe(edited)
  expect(chat.conversations[0].unread_messages[1].text_content).toBe('new text')
  expect(chat.conversations[0].last_message.uuid).toBe(latest.uuid)
  expect(chat.conversations[0].unread_message_count).toBe(2)
})

test('removes a recalled message and its unread preview, keeping the previous message as the summary', () => {
  chat.applyMessageUpdate({
    conversation_uuid: conversationUUID,
    uuid: latest.uuid,
    updated_at: edited,
    recalled_at: edited,
    conversation_last_message: original,
    unread_message_count: 1
  })
  chat.applyMessageUpdate({
    conversation_uuid: conversationUUID,
    uuid: latest.uuid,
    updated_at: outdated,
    edited_at: outdated,
    conversation_last_message: latest,
    unread_message_count: 2
  })

  expect(chat.getCurrentConversationMessages.map(({ uuid }) => uuid)).toEqual([original.uuid])
  expect(chat.conversations[0].unread_messages).toEqual([original])
  expect(chat.conversations[0].last_message).toEqual(original)
  expect(chat.conversations[0].unread_message_count).toBe(1)
})

test('reloads a snapshot that raced a recall', async () => {
  let resolveOldResponse
  api.getChatConversation
    .mockImplementationOnce(() => new Promise((resolve) => { resolveOldResponse = resolve }))
    .mockResolvedValueOnce(conversationResponse([latest]))
  chat.replaceMessages([original])
  const loaded = chat.loadConversation(conversationUUID, true, true)
  chat.applyMessageUpdate({
    conversation_uuid: conversationUUID,
    uuid: original.uuid,
    updated_at: edited,
    recalled_at: edited,
    unread_message_count: 0
  })
  resolveOldResponse(conversationResponse([original]))

  expect(await loaded).toBe(true)
  expect(api.getChatConversation).toHaveBeenCalledTimes(2)
  expect(chat.getCurrentConversationMessages).toEqual([latest])
})

test('clears cached history when all messages were recalled while disconnected', async () => {
  api.getChatConversation.mockResolvedValueOnce(conversationResponse([]))

  expect(await chat.loadConversation(conversationUUID, true, true)).toBe(true)
  expect(chat.getCurrentConversationMessages).toEqual([])
})

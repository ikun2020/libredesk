// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive } from 'vue'

const api = vi.hoisted(() => ({
  initChatConversation: vi.fn(),
  sendChatMessage: vi.fn(),
  uploadMedia: vi.fn()
}))
const saveSession = vi.hoisted(() => vi.fn())
const widget = reactive({ config: {}, isOpen: true })
const user = reactive({ userSessionToken: '', isVisitor: true, userID: null })
const chat = reactive({ currentConversation: {}, drafts: {} })
const proactive = reactive({ pending: null, replyPayload: vi.fn(), replied: vi.fn() })

vi.mock('@widget/api/index.js', () => ({ default: api, saveSession }))
vi.mock('@widget/store/widget.js', () => ({ useWidgetStore: () => widget }))
vi.mock('@widget/store/chat.js', () => ({ useChatStore: () => chat }))
vi.mock('@widget/store/user.js', () => ({ useUserStore: () => user }))
vi.mock('@widget/store/proactive.js', () => ({ useProactiveStore: () => proactive }))
vi.mock('@widget/websocket.js', () => ({ sendWidgetTyping: vi.fn() }))
vi.mock('@shared-ui/utils/http.js', () => ({ handleHTTPError: (error) => error }))

import MessageInput from './MessageInput.vue'

let app
let host
let instance
const onError = vi.fn()
const settle = async () => {
  await nextTick()
  await nextTick()
  await nextTick()
}
const deferred = () => {
  let resolve, reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
const response = () => ({
  data: {
    data: {
      conversation: { uuid: 'created-conversation' },
      messages: [{ uuid: 'first-file', content: '', attachments: [{ name: 'receipt.txt' }] }],
      session_token: 'new-session',
      user: { user_id: 42, is_visitor: true }
    }
  }
})
const file = () => new File(['receipt'], 'receipt.txt', { type: 'text/plain' })
const select = async (files) => {
  const input = host.querySelector('input[type="file"]')
  Object.defineProperty(input, 'files', { configurable: true, value: files })
  input.dispatchEvent(new Event('change', { bubbles: true }))
  await settle()
}
const mount = async () => {
  host = document.createElement('div')
  document.body.append(host)
  app = createApp({
    render: () =>
      h(MessageInput, {
        ref: (value) => {
          instance = value
        },
        onError
      })
  })
  app.config.globalProperties.$t = (key) => key
  app.mount(host)
  await settle()
}

beforeEach(() => {
  vi.clearAllMocks()
  for (const mock of Object.values(api)) mock.mockReset()
  api.initChatConversation.mockResolvedValue(response())
  api.sendChatMessage.mockResolvedValue({ data: { data: { uuid: 'text-message' } } })
  widget.config = { features: { file_upload: true }, visitors: { quick_replies: ['Hello'] } }
  user.userSessionToken = ''
  user.isVisitor = true
  chat.currentConversation = {}
  chat.drafts = {}
  Object.assign(chat, {
    addConversationToList: vi.fn(),
    setCurrentConversation: vi.fn((conversation) => {
      chat.currentConversation = conversation
    }),
    replaceMessages: vi.fn(),
    addPendingMessage: vi.fn(() => 'pending-file'),
    replaceMessage: vi.fn(),
    updateConversationListLastMessage: vi.fn(),
    removeMessage: vi.fn()
  })
  proactive.pending = null
  proactive.replyPayload.mockReturnValue({})
})

afterEach(() => {
  app?.unmount()
  host?.remove()
})

describe('first-message attachments', () => {
  it('starts a conversation with the file and retains the unsent text draft', async () => {
    chat.drafts.new = 'Keep this text until I send it'
    await mount()
    expect(host.querySelector('[aria-label="globals.messages.attachFile"]')).not.toBeNull()
    const attachment = file()
    await select([attachment])

    expect(api.initChatConversation).toHaveBeenCalledExactlyOnceWith({ message: '' }, [attachment])
    expect(api.uploadMedia).not.toHaveBeenCalled()
    expect(saveSession).toHaveBeenCalledWith(
      'new-session',
      { user_id: 42, is_visitor: true },
      user,
      true
    )
    expect(chat.replaceMessages).toHaveBeenCalledWith(response().data.data.messages)
    expect(chat.currentConversation.uuid).toBe('created-conversation')
    expect(host.querySelector('textarea').value).toBe('Keep this text until I send it')
    expect(chat.drafts.new).toBeUndefined()

    host.querySelector('[aria-label="globals.messages.send"]').click()
    await settle()
    expect(api.sendChatMessage).toHaveBeenCalledWith('created-conversation', {
      message: 'Keep this text until I send it'
    })
    expect(api.initChatConversation).toHaveBeenCalledTimes(1)
  })

  it('blocks Enter, suggested replies, and a second file while the initial upload is pending', async () => {
    const pending = deferred()
    api.initChatConversation.mockReturnValue(pending.promise)
    chat.drafts.new = 'Unsent draft'
    await mount()
    await select([file()])

    const textarea = host.querySelector('textarea')
    expect(textarea.disabled).toBe(true)
    expect(host.querySelector('input[type="file"]').disabled).toBe(true)
    expect(
      host.querySelector('[aria-label="globals.messages.attachFile"]').getAttribute('aria-busy')
    ).toBe('true')
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    instance.sendQuickReply('Do not replace draft')
    await select([file()])
    expect(chat.drafts.new).toBe('Unsent draft')
    expect(api.initChatConversation).toHaveBeenCalledTimes(1)
    expect(api.sendChatMessage).not.toHaveBeenCalled()

    pending.resolve(response())
    await settle()
    expect(textarea.disabled).toBe(false)
  })

  it('keeps the draft and permits retrying the same file after a failed initial upload', async () => {
    api.initChatConversation.mockRejectedValueOnce(new Error('Upload rejected'))
    chat.drafts.new = 'Please keep this'
    await mount()
    const attachment = file()
    await select([attachment])
    expect(onError).toHaveBeenCalledWith('Upload rejected')
    expect(chat.addConversationToList).not.toHaveBeenCalled()
    expect(chat.drafts.new).toBe('Please keep this')
    expect(host.querySelector('input[type="file"]').disabled).toBe(false)

    await select([attachment])
    expect(api.initChatConversation).toHaveBeenCalledTimes(2)
    expect(chat.currentConversation.uuid).toBe('created-conversation')
    expect(onError).toHaveBeenLastCalledWith('')
  })

  it('does nothing for cancelled selection or when uploads are disabled', async () => {
    await mount()
    await select([])
    widget.config.features.file_upload = false
    await settle()
    expect(host.querySelector('[aria-label="globals.messages.attachFile"]')).toBeNull()
    await select([file()])
    expect(api.initChatConversation).not.toHaveBeenCalled()
    expect(api.uploadMedia).not.toHaveBeenCalled()
  })

  it('includes campaign context and moves its draft to the created conversation', async () => {
    proactive.pending = { id: 'campaign-delivery' }
    proactive.replyPayload.mockReturnValue({
      delivery_id: 'campaign-delivery',
      browser_key: 'browser-key'
    })
    chat.drafts['campaign-delivery'] = 'Campaign reply draft'
    user.userSessionToken = 'existing-session'
    await mount()
    await select([file()])
    expect(api.initChatConversation.mock.calls[0][0]).toEqual({
      message: '',
      delivery_id: 'campaign-delivery',
      browser_key: 'browser-key'
    })
    expect(saveSession).not.toHaveBeenCalled()
    expect(proactive.replied).toHaveBeenCalledOnce()
    expect(chat.drafts['created-conversation']).toBe('Campaign reply draft')
    expect(chat.drafts['campaign-delivery']).toBeUndefined()
  })

  it('does not replace a different conversation opened during the initial upload', async () => {
    const pending = deferred()
    api.initChatConversation.mockReturnValue(pending.promise)
    await mount()
    await select([file()])
    chat.currentConversation = { uuid: 'other-conversation' }
    pending.resolve(response())
    await settle()
    expect(chat.addConversationToList).toHaveBeenCalledOnce()
    expect(chat.currentConversation.uuid).toBe('other-conversation')
    expect(chat.replaceMessages).not.toHaveBeenCalled()
  })

  it.each(['anonymous reset', 'signed-in logout', 'identity switch'])(
    'discards the initial upload response after %s',
    async (reset) => {
      const pending = deferred()
      api.initChatConversation.mockReturnValue(pending.promise)
      user.userSessionToken = reset === 'anonymous reset' ? '' : 'old-session'
      chat.drafts.new = 'Private draft'
      await mount()
      await select([file()])

      chat.drafts = {}
      chat.currentConversation = {}
      user.userSessionToken = reset === 'identity switch' ? 'another-session' : ''
      pending.resolve(response())
      await settle()

      expect(saveSession).not.toHaveBeenCalled()
      expect(chat.addConversationToList).not.toHaveBeenCalled()
      expect(chat.setCurrentConversation).not.toHaveBeenCalled()
      expect(chat.replaceMessages).not.toHaveBeenCalled()
      expect(proactive.replied).not.toHaveBeenCalled()
      expect(chat.drafts).toEqual({})
      expect(host.querySelector('textarea').disabled).toBe(false)
    }
  )

  it.each([false, true])(
    'settles an existing upload in its original conversation (failure=%s)',
    async (fails) => {
      const pending = deferred()
      api.uploadMedia.mockReturnValue(pending.promise)
      chat.currentConversation = { uuid: 'original-conversation' }
      await mount()
      const attachment = file()
      await select([attachment])
      chat.currentConversation = { uuid: 'other-conversation' }
      if (fails) pending.reject(new Error('Upload failed'))
      else pending.resolve({ data: { data: { uuid: 'uploaded-file' } } })
      await settle()
      expect(api.initChatConversation).not.toHaveBeenCalled()
      expect(api.uploadMedia).toHaveBeenCalledExactlyOnceWith('original-conversation', [attachment])
      if (fails)
        expect(chat.removeMessage).toHaveBeenCalledWith('original-conversation', 'pending-file')
      else
        expect(chat.replaceMessage).toHaveBeenCalledWith('original-conversation', 'pending-file', {
          uuid: 'uploaded-file'
        })
      expect(chat.currentConversation.uuid).toBe('other-conversation')
    }
  )
})

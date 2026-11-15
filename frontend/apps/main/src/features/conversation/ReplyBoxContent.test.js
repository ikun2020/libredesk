// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive } from 'vue'

const editorFocus = vi.fn()
const { searchMacros, getMacro } = vi.hoisted(() => ({ searchMacros: vi.fn(), getMacro: vi.fn() }))
let sendFromEditor
const conversationStore = reactive({
  current: { uuid: 'conversation-1', inbox_channel: 'livechat' },
  getMacro: () => ({ actions: [] })
})

vi.mock('@main/stores/conversation', () => ({
  useConversationStore: () => conversationStore
}))
vi.mock('@main/stores/macro', () => ({
  useMacroStore: () => ({ setCurrentView: vi.fn() })
}))
vi.mock('@main/composables/useEmitter', () => ({
  useEmitter: () => ({ emit: vi.fn() })
}))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key) => key }) }))
vi.mock('@main/api', () => ({ default: { searchMacros, getMacro } }))
vi.mock('@main/components/editor/ConversationEditor.vue', () => ({
  default: {
    props: ['sendOnEnter', 'insertContent'],
    emits: ['send'],
    setup(editorProps, { expose, emit }) {
      expose({ focus: editorFocus })
      sendFromEditor = () => emit('send')
      return () => h('div', {
        contenteditable: true,
        'data-send-on-enter': editorProps.sendOnEnter,
        'data-insert-content': editorProps.insertContent
      })
    }
  }
}))
vi.mock('@/features/conversation/ReplyBoxMenuBar.vue', () => ({
  default: { render: () => null }
}))
vi.mock('@/features/conversation/MacroActionsPreview.vue', () => ({
  default: { render: () => null }
}))
vi.mock('@/features/conversation/message/attachment/ReplyBoxAttachmentPreview.vue', () => ({
  default: { render: () => null }
}))

import ReplyBoxContent from './ReplyBoxContent.vue'

let app
let host
let instance
let props
const onSend = vi.fn()

const settle = async () => {
  await nextTick()
  await nextTick()
}

const mount = async ({ touch = false, isDraftLoading = false } = {}) => {
  vi.stubGlobal('matchMedia', vi.fn((query) => ({
    matches: touch && query.includes('(pointer: coarse)'),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  })))
  props = reactive({
    isSending: false,
    uploadingFiles: [],
    canSendReply: true,
    canSendPrivateNote: true,
    isDraftLoading,
    messageType: 'reply'
  })
  host = document.createElement('div')
  document.body.append(host)
  app = createApp({
    render: () => h(ReplyBoxContent, { ...props, onSend, ref: (value) => { instance = value } })
  })
  app.config.globalProperties.$t = (key) => key
  app.mount(host)
  await settle()
}

beforeEach(() => {
  editorFocus.mockClear()
  onSend.mockClear()
  searchMacros.mockReset()
  getMacro.mockReset()
  conversationStore.current.uuid = 'conversation-1'
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  vi.unstubAllGlobals()
})

describe('reply editor focus', () => {
  it('allows explicit focus on a touch device without automatically focusing on mount', async () => {
    await mount({ touch: true })
    expect(editorFocus).not.toHaveBeenCalled()

    instance.focus()
    expect(editorFocus).toHaveBeenCalledOnce()
  })

  it('does not steal focus when a touch device loads a draft or changes reply mode or conversation', async () => {
    await mount({ touch: true, isDraftLoading: true })
    props.isDraftLoading = false
    await settle()
    props.messageType = 'private_note'
    await settle()
    conversationStore.current.uuid = 'conversation-2'
    await settle()

    expect(editorFocus).not.toHaveBeenCalled()
  })

  it('preserves desktop autofocus after a draft loads and the reply mode changes', async () => {
    await mount({ isDraftLoading: true })
    expect(editorFocus).not.toHaveBeenCalled()

    props.isDraftLoading = false
    await settle()
    expect(editorFocus).toHaveBeenCalledTimes(1)

    props.messageType = 'private_note'
    await settle()
    expect(editorFocus).toHaveBeenCalledTimes(2)
  })

  it('preserves desktop focus in another input when the conversation changes', async () => {
    await mount()
    expect(editorFocus).toHaveBeenCalledOnce()
    const input = document.createElement('input')
    host.append(input)
    input.focus()

    conversationStore.current.uuid = 'conversation-2'
    await settle()
    expect(editorFocus).toHaveBeenCalledOnce()
    expect(document.activeElement).toBe(input)
  })
})

describe('reply editor sending', () => {
  it.each([false, true])('enables Enter sending only on desktop (touch: %s)', async (touch) => {
    await mount({ touch })
    expect(host.querySelector('[contenteditable]').getAttribute('data-send-on-enter')).toBe(String(!touch))
  })

  it('blocks empty, uploading and in-flight replies from the keyboard, then sends valid content', async () => {
    await mount()
    sendFromEditor()
    await settle()
    expect(onSend).not.toHaveBeenCalled()

    props.htmlContent = '<p>Reply</p>'
    props.textContent = 'Reply'
    props.uploadingFiles = [{ name: 'attachment.png' }]
    await settle()
    sendFromEditor()
    await settle()
    expect(onSend).not.toHaveBeenCalled()

    props.uploadingFiles = []
    props.isSending = true
    await settle()
    sendFromEditor()
    await settle()
    expect(onSend).not.toHaveBeenCalled()

    props.isSending = false
    await settle()
    sendFromEditor()
    await settle()
    expect(onSend).toHaveBeenCalledOnce()
  })
})

describe('quick send', () => {
  const openQuickSend = () => {
    const trigger = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent.trim() === 'replyBox.quickSend'
    )
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  }

  beforeEach(() => {
    searchMacros.mockResolvedValue({ data: { data: [{ id: 1, name: 'Payment follow-up' }] } })
  })

  it('lists reply macros and inserts only the selected body without sending', async () => {
    getMacro.mockResolvedValue({ data: { data: {
      message_content: '<p>Thanks for your payment.</p>',
      visible_when: ['replying'],
      actions: [{ type: 'set_status', value: ['Closed'] }]
    } } })
    await mount()
    openQuickSend()

    await vi.waitFor(() => {
      expect(document.querySelector('[role="menuitem"]')?.textContent.trim()).toBe('Payment follow-up')
    })
    expect(searchMacros).toHaveBeenCalledWith({ view: 'replying', message_only: true })
    document.querySelector('[role="menuitem"]').click()

    await vi.waitFor(() => {
      expect(host.querySelector('[contenteditable]').getAttribute('data-insert-content'))
        .toBe('<p>Thanks for your payment.</p>')
    })
    expect(getMacro).toHaveBeenCalledWith(1)
    expect(onSend).not.toHaveBeenCalled()
  })

  it('discards a quick reply that finishes loading after changing conversations', async () => {
    let finishLoading
    getMacro.mockImplementation(() => new Promise((resolve) => { finishLoading = resolve }))
    await mount()
    openQuickSend()
    await vi.waitFor(() => expect(document.querySelector('[role="menuitem"]')).not.toBeNull())
    document.querySelector('[role="menuitem"]').click()

    conversationStore.current.uuid = 'conversation-2'
    await settle()
    finishLoading({ data: { data: { message_content: '<p>Old reply</p>', visible_when: ['replying'] } } })
    await settle()

    expect(host.querySelector('[contenteditable]').hasAttribute('data-insert-content')).toBe(false)
  })
})

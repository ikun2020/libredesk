// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive } from 'vue'

const editorFocus = vi.fn()
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
vi.mock('@main/api', () => ({ default: {} }))
vi.mock('@main/components/editor/ConversationEditor.vue', () => ({
  default: {
    setup(_, { expose }) {
      expose({ focus: editorFocus })
      return () => h('div', { contenteditable: true })
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
    render: () => h(ReplyBoxContent, { ...props, ref: (value) => { instance = value } })
  })
  app.config.globalProperties.$t = (key) => key
  app.mount(host)
  await settle()
}

beforeEach(() => {
  editorFocus.mockClear()
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

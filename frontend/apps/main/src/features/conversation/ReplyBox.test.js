// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive, ref } from 'vue'
import { EMITTER_EVENTS } from '@main/constants/emitterEvents'

const focus = vi.fn()
const { sendMessage } = vi.hoisted(() => ({ sendMessage: vi.fn().mockResolvedValue({}) }))
const draftHtml = ref('')
const draftText = ref('')
const listeners = new Map()
const route = reactive({ params: { uuid: 'conversation-1' } })
const conversationStore = reactive({
  current: { uuid: 'conversation-1', inbox_channel: 'livechat' },
  messages: { loading: true, fetching: true },
  conversationMessages: [],
  draftsReady: Promise.resolve(),
  resolveDraftType: () => 'reply',
  getMacro: () => ({}),
  addPendingMessage: vi.fn(),
  resetMacro: vi.fn()
})

vi.mock('@main/api', () => ({ default: { sendMessage } }))
vi.mock('vue-router', () => ({ useRoute: () => route }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key) => key }) }))
vi.mock('@main/stores/conversation', () => ({ useConversationStore: () => conversationStore }))
vi.mock('@main/stores/user', () => ({ useUserStore: () => ({ can: () => true }) }))
vi.mock('@main/stores/inbox', () => ({ useInboxStore: () => ({ inboxes: [] }) }))
vi.mock('@main/stores/notification', () => ({
  useNotificationStore: () => ({ markAssignmentAsReadForConversation: vi.fn() })
}))
vi.mock('@main/composables/useEmitter', () => ({
  useEmitter: () => ({
    on: (event, handler) => listeners.set(event, handler),
    off: (event) => listeners.delete(event)
  })
}))
vi.mock('@main/composables/useDraftManager', () => ({
  useDraftManager: () => ({
    htmlContent: draftHtml, textContent: draftText, isLoading: ref(false), clearDraft: vi.fn(),
    loadedAttachments: ref([]), loadedMacroActions: ref([]), loadedMacroID: ref(0)
  })
}))
vi.mock('@main/composables/useFileUpload', () => ({
  useFileUpload: () => ({ mediaFiles: ref([]), uploadingFiles: ref([]), clearMediaFiles: vi.fn() })
}))
vi.mock('./ReplyBoxContent.vue', async () => ({
  linkifyAgentReply: (await import('./linkifyAgentReply')).linkifyAgentReply,
  default: {
    emits: ['send'],
    setup(_, { expose, emit }) {
      expose({ focus })
      return () => h('button', { 'data-testid': 'reply-content', onClick: () => emit('send') })
    }
  }
}))

import ReplyBox from './ReplyBox.vue'

let app
let host
let frameID
const frames = new Map()
const paint = async () => {
  const callbacks = [...frames.values()]
  frames.clear()
  for (const callback of callbacks) callback()
  await nextTick()
  await vi.dynamicImportSettled()
}
const composer = () => host.querySelector('[data-testid="reply-content"]')

beforeEach(async () => {
  focus.mockClear()
  sendMessage.mockClear()
  draftHtml.value = ''
  draftText.value = ''
  localStorage.removeItem('replyBoxMinimized')
  conversationStore.messages.loading = true
  conversationStore.messages.fetching = true
  frames.clear()
  frameID = 0
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  vi.stubGlobal('requestAnimationFrame', (callback) => {
    const id = ++frameID
    frames.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id) => frames.delete(id))
  host = document.createElement('div')
  document.body.append(host)
  app = createApp(ReplyBox)
  app.config.globalProperties.$t = (key) => key
  app.mount(host)
  await nextTick()
})

it.each(['reply', 'private_note'])('only turns URLs into links when sending a public reply (%s)', async type => {
  await listeners.get(EMITTER_EVENTS.REPLY_BOX_FOCUS)()
  listeners.get(EMITTER_EVENTS.REPLY_BOX_SET_TYPE)(type)
  draftHtml.value = '<p>example.is</p>'
  draftText.value = 'example.is'
  await nextTick()
  composer().click()

  const isPrivate = type === 'private_note'
  expect(sendMessage).toHaveBeenCalledOnce()
  const [, body] = sendMessage.mock.calls[0]
  expect(body.private).toBe(isPrivate)
  if (isPrivate) expect(body.message).toBe('<p>example.is</p>')
  else expect(body.message).toContain('href="https://example.is/"')
  await nextTick()
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  vi.unstubAllGlobals()
})

describe('deferred reply composer', () => {
  it('waits for the thread to finish loading and paint before mounting the reply editor', async () => {
    await paint()
    expect(composer()).toBeNull()
    expect(frames.size).toBe(0)

    conversationStore.messages.loading = false
    conversationStore.messages.fetching = false
    await nextTick()
    await paint()
    expect(composer()).toBeNull()
    await paint()
    expect(composer()).not.toBeNull()
  })

  it('starts loading and preserves explicit focus when using the reply shortcut early', async () => {
    await listeners.get(EMITTER_EVENTS.REPLY_BOX_FOCUS)()
    expect(composer()).not.toBeNull()
    expect(focus).toHaveBeenCalledOnce()
  })
})

// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive } from 'vue'
import { TooltipProvider } from '@shared-ui/components/ui/tooltip'
import MessageBubble from './MessageBubble.vue'

const { current, recallLiveChatMessage, deleteMessage, canWrite } = vi.hoisted(() => ({
  current: { uuid: 'chat', inbox_channel: 'livechat' },
  recallLiveChatMessage: vi.fn(),
  deleteMessage: vi.fn(),
  canWrite: { value: true }
}))
vi.mock('@main/stores/conversation', () => ({
  useConversationStore: () => ({ current, recallLiveChatMessage, deleteMessage })
}))
vi.mock('@main/stores/user', () => ({
  useUserStore: () => ({ userID: 7, can: permission => permission === 'messages:write' && canWrite.value })
}))
vi.mock('@main/components/editor/ConversationEditor.vue', () => ({
  default: {
    props: { sendOnEnter: Boolean },
    setup: props => () => h('div', { 'data-send-on-enter': String(props.sendOnEnter) })
  }
}))
vi.mock('@main/composables/useWorkspaceDateTime', () => ({ useWorkspaceDateTime: () => ({}) }))
vi.mock('@main/api', () => ({ default: {} }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: key => key }) }))

beforeEach(() => {
  vi.clearAllMocks()
  current.inbox_channel = 'livechat'
  canWrite.value = true
  recallLiveChatMessage.mockResolvedValue(true)
})

function mountMessageBubble (message) {
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp({
    render: () => h(TooltipProvider, null, () => h(MessageBubble, {
      direction: 'outgoing', message, groupWithPrev: true, groupWithNext: true
    }))
  })
  app.config.globalProperties.$t = key => key
  app.component('RouterLink', { render: () => null })
  app.mount(host)
  return { app, host }
}

describe('message edits', () => {
  it('repaints the rich-text body when the same message is edited twice', async () => {
    const message = reactive({
      uuid: 'reply', id: 1, type: 'outgoing', status: 'sent', sender_id: 7, sender_type: 'agent',
      content_type: 'html', content: '<p>Original message</p>', attachments: []
    })
    const { app, host } = mountMessageBubble(message)

    try {
      const bubble = host.querySelector('.message-bubble')
      expect(bubble.textContent).toContain('Original message')

      message.content = '<p><strong>First correction</strong></p>'
      message.edited_at = '2026-11-17T14:00:00Z'
      await nextTick()
      expect(bubble.querySelector('strong')?.textContent).toBe('First correction')
      expect(bubble.textContent).toContain('conversation.messageEdited')
      expect(bubble.textContent).not.toContain('Original message')

      message.content = '<p>Second correction</p>'
      message.edited_at = '2026-11-17T14:01:00Z'
      await nextTick()
      expect(host.querySelector('.message-bubble')).toBe(bubble)
      expect(bubble.textContent).toContain('Second correction')
      expect(bubble.textContent).not.toContain('First correction')
    } finally {
      app.unmount()
      host.remove()
    }
  })

  it.each([false, true])('uses the editor Enter shortcut based on touch input (%s)', async (touch) => {
    vi.stubGlobal('matchMedia', query => ({
      matches: touch && query === '(pointer: coarse)',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }))
    const { app, host } = mountMessageBubble({
      uuid: 'reply', id: 1, type: 'outgoing', status: 'sent', sender_id: 7, sender_type: 'agent',
      created_at: new Date().toISOString(), content_type: 'text', content: 'Reply',
      text_content: 'Reply', attachments: []
    })
    try {
      const actions = host.querySelector('[aria-label="globals.messages.moreActions"]')
      actions.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      let editAction
      await vi.waitFor(() => {
        editAction = Array.from(document.querySelectorAll('[role="menuitem"]'))
          .find(item => item.textContent.trim() === 'conversation.editMessage')
        expect(editAction).toBeDefined()
      })
      editAction.click()
      await vi.waitFor(() => {
        const editor = document.querySelector('[data-send-on-enter]')
        expect(editor?.dataset.sendOnEnter).toBe(String(!touch))
      })
    } finally {
      app.unmount()
      host.remove()
      vi.unstubAllGlobals()
    }
  })
})

describe('recalling automatic replies', () => {
  const reply = overrides => ({
    uuid: 'automatic-reply', id: 2, type: 'outgoing', status: 'sent', sender_type: 'agent', sender_id: 9,
    created_at: new Date().toISOString(), content_type: 'text', content: 'Automatic reply',
    text_content: 'Automatic reply', attachments: [], ...overrides
  })

  it.each([
    ['automation', { meta: { is_automated: true }, author: { email: 'System' } }],
    ['legacy automation metadata', { meta: { is_automated: 'true' } }],
    ['AI reply metadata', { meta: { ai_assistant_id: 3 } }],
    ['AI assistant author', { author: { type: 'ai_assistant' } }]
  ])('recalls a sent %s message without offering edit', async (_, source) => {
    const { app, host } = mountMessageBubble(reply(source))
    try {
      const actions = host.querySelector('[aria-label="globals.messages.moreActions"]')
      expect(actions).not.toBeNull()
      actions.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      let recallAction
      await vi.waitFor(() => {
        const items = Array.from(document.querySelectorAll('[role="menuitem"]'))
        expect(items.find(item => item.textContent.trim() === 'conversation.editMessage')).toBeUndefined()
        recallAction = items.find(item => item.textContent.trim() === 'conversation.recallMessage')
        expect(recallAction).toBeDefined()
      })
      recallAction.click()
      await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).not.toBeNull())
      const confirm = Array.from(document.querySelectorAll('[role="alertdialog"] button'))
        .find(button => button.textContent.trim() === 'conversation.recallMessage')
      confirm.click()
      await vi.waitFor(() => expect(recallLiveChatMessage).toHaveBeenCalledWith('chat', 'automatic-reply'))
    } finally {
      app.unmount()
      host.remove()
    }
  })

  it.each([
    ['another human reply', {}],
    ['unmarked System reply', { author: { email: 'System' } }],
    ['pending automatic reply', { status: 'pending', meta: { is_automated: true } }],
    ['private automatic note', { private: true, meta: { is_automated: true } }],
    ['automatic activity', { type: 'activity', meta: { is_automated: true } }],
    ['recalled automatic reply', { recalled_at: '2026-11-23T10:00:00Z', meta: { is_automated: true } }],
    ['CSAT', { meta: { is_automated: true, is_csat: true } }],
    ['campaign reply', { meta: { ai_assistant_id: 3, campaign_id: 1 } }],
    ['campaign metadata set to zero', { meta: { is_automated: true, campaign_id: 0 } }],
    ['continuity email', { meta: { is_automated: true, continuity_email: true } }]
  ])('keeps actions unavailable for %s', async (_, overrides) => {
    const { app, host } = mountMessageBubble(reply(overrides))
    try {
      await nextTick()
      expect(host.querySelector('[aria-label="globals.messages.moreActions"]')).toBeNull()
    } finally {
      app.unmount()
      host.remove()
    }
  })

  it.each(['email', 'whatsapp'])('keeps automatic recall unavailable in the %s channel', (channel) => {
    current.inbox_channel = channel
    const { app, host } = mountMessageBubble(reply({ meta: { is_automated: true } }))
    try {
      expect(host.querySelector('[aria-label="globals.messages.moreActions"]')).toBeNull()
    } finally {
      app.unmount()
      host.remove()
    }
  })

  it('requires message-write permission for automatic recall', () => {
    canWrite.value = false
    const { app, host } = mountMessageBubble(reply({ meta: { is_automated: true } }))
    try {
      expect(host.querySelector('[aria-label="globals.messages.moreActions"]')).toBeNull()
    } finally {
      app.unmount()
      host.remove()
    }
  })

  it('continues to delete own private notes through the note action', async () => {
    const { app, host } = mountMessageBubble(reply({ sender_id: 7, private: true }))
    try {
      const actions = host.querySelector('[aria-label="globals.messages.moreActions"]')
      actions.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      let deleteAction
      await vi.waitFor(() => {
        const items = Array.from(document.querySelectorAll('[role="menuitem"]'))
        expect(items.find(item => item.textContent.trim() === 'conversation.editMessage')).toBeUndefined()
        expect(items.find(item => item.textContent.trim() === 'conversation.recallMessage')).toBeUndefined()
        deleteAction = items.find(item => item.textContent.trim() === 'conversation.deletePrivateNote')
        expect(deleteAction).toBeDefined()
      })
      deleteAction.click()
      await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).not.toBeNull())
      const confirm = Array.from(document.querySelectorAll('[role="alertdialog"] button'))
        .find(button => button.textContent.trim() === 'globals.messages.delete')
      confirm.click()
      await vi.waitFor(() => expect(deleteMessage).toHaveBeenCalledWith('chat', 'automatic-reply'))
      expect(recallLiveChatMessage).not.toHaveBeenCalled()
    } finally {
      app.unmount()
      host.remove()
    }
  })
})

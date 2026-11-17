// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive } from 'vue'
import { TooltipProvider } from '@shared-ui/components/ui/tooltip'
import MessageBubble from './MessageBubble.vue'

vi.mock('@main/stores/conversation', () => ({
  useConversationStore: () => ({ current: { uuid: 'chat', inbox_channel: 'livechat' } })
}))
vi.mock('@main/stores/user', () => ({
  useUserStore: () => ({ userID: 7, can: () => false })
}))
vi.mock('@main/components/editor/ConversationEditor.vue', () => ({ default: { render: () => null } }))
vi.mock('@main/composables/useWorkspaceDateTime', () => ({ useWorkspaceDateTime: () => ({}) }))
vi.mock('@main/api', () => ({ default: {} }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: key => key }) }))

describe('message edits', () => {
  it('repaints the rich-text body when the same message is edited twice', async () => {
    const message = reactive({
      uuid: 'reply', id: 1, status: 'sent', sender_id: 7, sender_type: 'agent',
      content_type: 'html', content: '<p>Original message</p>', attachments: []
    })
    const host = document.createElement('div')
    document.body.append(host)
    const app = createApp({
      render: () => h(TooltipProvider, null, () => h(MessageBubble, {
        direction: 'outgoing', message, groupWithPrev: true, groupWithNext: true
      }))
    })
    app.component('RouterLink', { render: () => null })
    app.mount(host)

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
})

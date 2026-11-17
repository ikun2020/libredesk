// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { createApp, nextTick } from 'vue'
import { createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { useChatStore } from '@widget/store/chat.js'
import { useWidgetStore } from '@widget/store/widget.js'
import ChatMessages from './ChatMessages.vue'

it('updates a displayed HTML reply in place when it is edited', async () => {
  const pinia = createPinia()
  const chat = useChatStore(pinia)
  useWidgetStore(pinia).updateConfig({ notice_banner: { enabled: false } })
  chat.setCurrentConversation({ uuid: 'conversation' })
  chat.replaceMessages([{
    uuid: 'message',
    author: { id: 1, type: 'agent', first_name: 'Agent' },
    status: 'sent',
    content: '<p>Original reply</p>',
    content_type: 'html',
    created_at: '2026-11-17T10:00:00Z',
    attachments: []
  }])

  const host = document.createElement('div')
  const app = createApp(ChatMessages)
  app.use(pinia)
  app.use(createI18n({
    legacy: false,
    locale: 'en',
    messages: { en: { conversation: { messageEdited: 'Edited' } } }
  }))
  app.mount(host)
  try {
    const message = () => host.querySelector('[data-message-uuid="message"]')
    const bubble = message()
    expect(bubble.querySelector('p').textContent).toBe('Original reply')

    chat.applyMessageUpdate({
      conversation_uuid: 'conversation',
      uuid: 'message',
      content: '<p>Corrected reply</p>',
      text_content: 'Corrected reply',
      content_type: 'html',
      updated_at: '2026-11-17T10:01:00Z',
      edited_at: '2026-11-17T10:01:00Z'
    })
    await nextTick()

    expect(message()).toBe(bubble)
    expect(bubble.querySelector('p').textContent).toBe('Corrected reply')
    expect(bubble.textContent).toContain('Edited')
  } finally {
    app.unmount()
  }
})

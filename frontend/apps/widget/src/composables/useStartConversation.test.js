// @vitest-environment jsdom
import { beforeEach, expect, test, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useStartConversation } from './useStartConversation.js'
import { useChatStore } from '@widget/store/chat.js'
import { useUserStore } from '@widget/store/user.js'
import { useWidgetStore } from '@widget/store/widget.js'

let chat, user, widget

beforeEach(() => {
  setActivePinia(createPinia())
  chat = useChatStore()
  user = useUserStore()
  widget = useWidgetStore()
  user.setUserMeta({ user_id: 1, is_visitor: false }, 'support-sync')
  const previous = (uuid, status_category, date) => ({
    uuid, status_category, last_message: { created_at: date }
  })
  chat.conversations = [
    previous('older-open', 'open', '2026-05-01'),
    previous('newer-closed', 'resolved', '2026-05-03'),
    previous('current', 'pending', '2026-05-02'),
  ]
})

test('verified user can continue the latest ongoing thread even when creating new ones is disabled', async () => {
  const draft = 'draft kept on another tab'
  chat.drafts.current = draft
  widget.config = { users: { allow_start_conversation: false } }
  const load = vi.spyOn(chat, 'loadConversation').mockResolvedValue(true)
  const action = useStartConversation()
  expect(action.canOpenConversation.value).toBe(true)
  expect(action.ongoingConversation.value.uuid).toBe('current')
  await action.openConversation()
  expect(load).toHaveBeenCalledExactlyOnceWith('current')
  expect(widget.isChatView).toBe(true)
  expect(chat.drafts.current).toBe(draft)
})

test('ordinary identity uses the configured new-conversation flow', async () => {
  user.clearSessionToken()
  user.setUserMeta({ user_id: 1, is_visitor: false })
  widget.config = { users: { allow_start_conversation: true, start_conversation_button_text: 'Send' } }
  const load = vi.spyOn(chat, 'loadConversation').mockResolvedValue(true)
  const action = useStartConversation()
  expect(action.ongoingConversation.value).toBeUndefined()
  expect(action.configuredLabel.value).toBe('Send')
  expect(action.canOpenConversation.value).toBe(true)
  await action.openConversation()
  expect(load).not.toHaveBeenCalled()
  expect(widget.isChatView).toBe(true)
})

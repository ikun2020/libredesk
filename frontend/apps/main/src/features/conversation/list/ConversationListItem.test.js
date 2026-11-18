// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { createPinia, disposePinia } from 'pinia'
import mitt from 'mitt'
import { initI18n } from '@main/i18n'
import { useConversationStore } from '@main/stores/conversation'
import { TooltipProvider } from '@shared-ui/components/ui/tooltip'
import ConversationListItem from './ConversationListItem.vue'

let app
let pinia
let host

afterEach(() => {
  app?.unmount()
  if (pinia) disposePinia(pinia)
  host?.remove()
})

it('shows the latest public message across assignment, reply and note updates', async () => {
  const uuid = 'conversation-a'
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:uuid', name: 'inbox-conversation', component: { render: () => null } }]
  })
  let store
  app = createApp({
    setup() {
      store = useConversationStore()
      store.conversations.data = [{
        uuid, status: 'open', contact: {},
        last_message: 'Assigned to the agent',
        last_interaction: 'I need help',
        last_interaction_sender: 'contact'
      }]
      return () => h(TooltipProvider, null, () => h(ConversationListItem, {
        conversation: store.conversations.data[0], contactFullName: 'Visitor'
      }))
    }
  })
  app.config.globalProperties.emitter = mitt()
  pinia = createPinia()
  app.use(pinia).use(router).use(initI18n({
    legacy: false,
    locale: 'en',
    messages: { en: { globals: { messages: { markAsUnread: 'Mark as unread' } } } }
  }))
  await router.push(`/${uuid}`)
  host = document.createElement('div')
  document.body.append(host)
  app.mount(host)

  expect(host.textContent).toContain('I need help')
  expect(host.textContent).not.toContain('Assigned to the agent')
  expect(host.querySelector('.lucide-reply')).toBeNull()

  store.handleConvPush({ uuid, last_message: 'New assignment', last_interaction: 'I need help', last_interaction_sender: 'contact' })
  await nextTick()
  expect(host.textContent).toContain('I need help')
  expect(host.textContent).not.toContain('New assignment')

  store.handleConvPush({ uuid, last_message: 'Agent follow-up', last_interaction: 'Agent follow-up', last_interaction_sender: 'agent' })
  await nextTick()
  expect(host.textContent).toContain('Agent follow-up')
  expect(host.textContent).not.toContain('I need help')
  expect(host.querySelector('.lucide-reply')).not.toBeNull()

  store.handleConvPush({ uuid, last_message: 'Private note', last_interaction: 'Agent follow-up', last_interaction_sender: 'agent' })
  await nextTick()
  expect(host.textContent).toContain('Agent follow-up')
  expect(host.textContent).not.toContain('Private note')

  store.handleConvPush({ uuid, last_message: 'Thanks!', last_interaction: 'Thanks!', last_interaction_sender: 'contact' })
  await nextTick()
  expect(host.textContent).toContain('Thanks!')
  expect(host.querySelector('.lucide-reply')).toBeNull()
})

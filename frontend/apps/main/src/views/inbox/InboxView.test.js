// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createApp, nextTick, reactive, ref } from 'vue'

const { detailModule } = vi.hoisted(() => ({
  detailModule: vi.fn(() => ({ default: { render: () => null } }))
}))
const visibility = ref('visible')
const route = reactive({ name: 'inbox', params: { type: 'assigned' } })
const store = reactive({
  conversations: { initialized: false, loading: true, data: [], listType: 'assigned' },
  getListStatus: 'Open',
  fetchConversationsList: vi.fn(),
  refreshConversationList: vi.fn(),
  refreshInboxAfterResume: vi.fn()
})

vi.mock('vue-router', () => ({ useRoute: () => route }))
vi.mock('@vueuse/core', async (importOriginal) => ({
  ...await importOriginal(),
  useDocumentVisibility: () => visibility
}))
vi.mock('@main/stores/conversation', () => ({ useConversationStore: () => store }))
vi.mock('@main/features/conversation/ConversationPlaceholder.vue', () => ({ default: { render: () => null } }))
vi.mock('@main/views/conversation/ConversationDetailView.vue', () => detailModule())

let app

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('requestAnimationFrame', fn => window.setTimeout(fn, 16))
  vi.stubGlobal('cancelAnimationFrame', id => window.clearTimeout(id))
})

afterEach(() => {
  app?.unmount()
  app = undefined
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('warms the conversation page only after the inbox paints and cancels when hidden', async () => {
  const idle = vi.fn(fn => window.setTimeout(fn, 20))
  vi.stubGlobal('requestIdleCallback', idle)
  vi.stubGlobal('cancelIdleCallback', id => window.clearTimeout(id))
  const { default: InboxView } = await import('./InboxView.vue')
  const { loadConversationDetail } = await import('@main/router/conversation-detail')
  app = createApp(InboxView)
  app.component('RouterView', { render: () => null })
  app.mount(document.createElement('div'))

  await vi.advanceTimersByTimeAsync(1000)
  expect(idle).not.toHaveBeenCalled()
  expect(detailModule).not.toHaveBeenCalled()

  Object.assign(store.conversations, { initialized: true, loading: false, data: [{ uuid: 'conversation-a' }] })
  await nextTick()
  await vi.advanceTimersByTimeAsync(31)
  expect(idle).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(idle).toHaveBeenCalledTimes(1)

  visibility.value = 'hidden'
  await nextTick()
  await vi.advanceTimersByTimeAsync(1000)
  expect(detailModule).not.toHaveBeenCalled()

  visibility.value = 'visible'
  await nextTick()
  await vi.advanceTimersByTimeAsync(52)
  await vi.dynamicImportSettled()
  expect(detailModule).toHaveBeenCalledTimes(1)
  const navigation = loadConversationDetail()
  expect(loadConversationDetail()).toBe(navigation)
  await expect(navigation).resolves.toHaveProperty('default')
  expect(store.fetchConversationsList).toHaveBeenCalledTimes(1)
})

it('waits until after the inbox paints on browsers without an idle callback', async () => {
  vi.resetModules()
  vi.stubGlobal('requestIdleCallback', undefined)
  const { scheduleConversationDetailPreload } = await import('@main/router/conversation-detail')
  const isReady = vi.fn(() => false)

  const cancel = scheduleConversationDetailPreload(isReady)
  await vi.advanceTimersByTimeAsync(531)
  expect(isReady).not.toHaveBeenCalled()
  cancel()
  await vi.advanceTimersByTimeAsync(1)
  expect(isReady).not.toHaveBeenCalled()

  scheduleConversationDetailPreload(isReady)
  await vi.advanceTimersByTimeAsync(532)
  expect(isReady).toHaveBeenCalledOnce()
})

// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createApp, h, ref } from 'vue'
import { createI18n } from 'vue-i18n'
import InboxBulkStatusMenu from './InboxBulkStatusMenu.vue'

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  resetConversations: vi.fn(),
  fetchFirstPageConversations: vi.fn(),
  fetchSidebarCounts: vi.fn(),
  emit: vi.fn()
}))
vi.mock('@main/api', () => ({ default: { updateInboxOpenConversationStatus: mocks.update } }))
vi.mock('@main/stores/conversation', () => ({ useConversationStore: () => mocks }))
vi.mock('@main/composables/useEmitter', () => ({ useEmitter: () => ({ emit: mocks.emit }) }))

const scope = { list_type: 'assigned', list_id: 0, filters: '[]' }
let app, host, activeScope
const envelope = (data) => ({ data: { data } })

beforeEach(() => {
  vi.resetAllMocks()
  activeScope = ref(scope)
  app = createApp({
    render: () => h(InboxBulkStatusMenu, { scope: activeScope.value, inboxTitle: '我的收件箱' })
  })
  app.use(createI18n({
    legacy: false,
    locale: 'zh-CN',
    flatJson: true,
    messages: { 'zh-CN': {
      'conversation.bulkActions.inboxMenu': '批量操作',
      'conversation.bulkActions.resolveAllOpen': '一键解决',
      'conversation.bulkActions.closeAllOpen': '一键关闭',
      'conversation.bulkActions.confirmAllOpen': '「{inbox}」共 {count} 个打开的会话',
      'conversation.bulkActions.inboxChanged': '列表已变化',
      'conversation.bulkActions.noOpenConversations': '没有打开的会话',
      'conversation.bulkActions.successToast': '已更新',
      'globals.messages.cancel': '取消',
      'globals.terms.loading': '加载中'
    } }
  }))
  host = document.createElement('div')
  document.body.append(host)
  app.mount(host)
})

afterEach(() => {
  app.unmount()
  host.remove()
})

async function choose (label) {
  host.querySelector('button').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  await vi.waitFor(() => {
    expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(2)
  })
  const entry = [...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent.trim() === label)
  entry.click()
  await vi.waitFor(() => {
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull()
  })
}

const dialog = () => document.querySelector('[role="alertdialog"]')
const button = label => [...dialog().querySelectorAll('button')].find(el => el.textContent.trim() === label)

it('previews across pages and applies resolve only after confirmation', async () => {
  mocks.update.mockResolvedValueOnce(envelope({ total: 26, snapshot: 'snapshot-1' }))
    .mockResolvedValueOnce(envelope({ total: 26, updated: 26, skipped: 0, failed: 0 }))
  await choose('一键解决')
  await vi.waitFor(() => expect(dialog().textContent).toContain('「我的收件箱」共 26 个打开的会话'))
  expect(mocks.update).toHaveBeenCalledExactlyOnceWith({ ...scope, status: 'Resolved', preview: true })

  button('一键解决').click()
  await vi.waitFor(() => expect(mocks.fetchFirstPageConversations).toHaveBeenCalledOnce())
  expect(mocks.update).toHaveBeenLastCalledWith({ ...scope, status: 'Resolved', snapshot: 'snapshot-1' })
  expect(mocks.resetConversations).toHaveBeenCalledOnce()
  expect(mocks.fetchSidebarCounts).toHaveBeenCalledWith({ force: true })
})

it('requires a new confirmation if open conversations change, and can then be cancelled', async () => {
  mocks.update.mockResolvedValueOnce(envelope({ total: 2, snapshot: 'old' }))
    .mockRejectedValueOnce({ response: { status: 409 } })
    .mockResolvedValueOnce(envelope({ total: 3, snapshot: 'new' }))
  await choose('一键关闭')
  button('一键关闭').click()

  await vi.waitFor(() => expect(dialog().textContent).toContain('共 3 个打开的会话'))
  expect(dialog().textContent).toContain('列表已变化')
  expect(mocks.update.mock.calls.map(([request]) => request)).toEqual([
    { ...scope, status: 'Closed', preview: true },
    { ...scope, status: 'Closed', snapshot: 'old' },
    { ...scope, status: 'Closed', preview: true }
  ])
  await vi.waitFor(() => expect(button('取消').disabled).toBe(false))
  button('取消').click()
  await vi.waitFor(() => expect(dialog()).toBeNull())
  expect(mocks.update).toHaveBeenCalledTimes(3)
})

it('dismisses a confirmation when the current inbox changes', async () => {
  mocks.update.mockResolvedValueOnce(envelope({ total: 1, snapshot: 'assigned' }))
  await choose('一键解决')
  activeScope.value = { ...scope, list_type: 'all' }
  await vi.waitFor(() => expect(dialog()).toBeNull())
  expect(mocks.update).toHaveBeenCalledExactlyOnceWith({ ...scope, status: 'Resolved', preview: true })
})

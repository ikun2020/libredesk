// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import { createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import DaySeparator from '@shared-ui/components/DaySeparator/DaySeparator.vue'
import { useAppSettingsStore } from '@main/stores/appSettings'
import { useWorkspaceDateTime } from './useWorkspaceDateTime'

vi.mock('@main/api', () => ({ default: {} }))

let app
let host
afterEach(() => {
  app?.unmount()
  host?.remove()
})

describe('workspace time zone in mounted conversation content', () => {
  it('updates the message timestamp, date label, and day grouping when settings arrive or change', async () => {
    const pinia = createPinia()
    const store = useAppSettingsStore(pinia)
    const timestamp = '2026-11-13T16:18:00Z'
    host = document.createElement('div')
    document.body.append(host)
    app = createApp({
      setup () {
        const { formatMessageTimestamp, formatDate, isSameDay } = useWorkspaceDateTime()
        return () => h('div', [
          h('time', formatMessageTimestamp(timestamp)),
          h(DaySeparator, { date: timestamp, label: formatDate(timestamp) }),
          h('output', String(isSameDay('2026-11-13T15:59:00Z', timestamp)))
        ])
      }
    })
    app.use(pinia)
    app.use(createI18n({ legacy: false, locale: 'en', messages: { en: {} } }))
    app.mount(host)
    expect(host.querySelector('time').textContent).toBe('2026-11-13 16:18')
    expect(host.querySelector('output').textContent).toBe('true')

    store.setSettings({ 'app.timezone': 'Asia/Shanghai' })
    await nextTick()
    expect(host.querySelector('time').textContent).toBe('2026-11-14 00:18')
    expect(host.querySelector('span').textContent).toBe('2026-11-14')
    expect(host.querySelector('output').textContent).toBe('false')

    store.setSettings({ 'app.timezone': 'America/New_York' })
    await nextTick()
    expect(host.querySelector('time').textContent).toBe('2026-11-13 11:18')
    expect(host.querySelector('span').textContent).toBe('2026-11-13')
    expect(host.querySelector('output').textContent).toBe('true')
  })
})

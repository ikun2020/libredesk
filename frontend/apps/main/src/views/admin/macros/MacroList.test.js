// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import mitt from 'mitt'
import { EMITTER_EVENTS } from '@main/constants/emitterEvents.js'
import MacroList from './MacroList.vue'

const { getMacrosCompact, updateMacroOrder } = vi.hoisted(() => ({
  getMacrosCompact: vi.fn(),
  updateMacroOrder: vi.fn()
}))
vi.mock('@main/api', () => ({ default: { getMacrosCompact, updateMacroOrder } }))
vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key, values) => values ? `${key}: ${values.name}` : key })
}))
vi.mock('@main/components/datatable/DataTable.vue', () => ({
  default: {
    props: ['data'],
    render() {
      return h('div', { 'data-table': '' }, this.data.map((macro) => macro.name).join(', '))
    }
  }
}))

const original = [{ id: 7, name: 'First' }, { id: 4, name: 'Second' }]
const afterSave = [original[1], original[0], { id: 9, name: 'New macro' }]
const listResponse = (macros) => ({ data: { data: macros } })
let app
let host
let emitter

const findButton = (label) => Array.from(host.querySelectorAll('button')).find(
  (button) => button.textContent.trim() === label || button.getAttribute('aria-label') === label
)
const sortRowNames = () => Array.from(host.querySelectorAll('ol li'), (row) =>
  row.querySelector('span:not([aria-hidden])').textContent.trim()
)
const click = async (label) => {
  findButton(label).click()
  await nextTick()
}
const mount = async () => {
  host = document.createElement('div')
  document.body.append(host)
  app = createApp(MacroList)
  app.component('RouterLink', { render() { return h('a', this.$slots.default()) } })
  app.config.globalProperties.$t = (key) => key
  emitter = mitt()
  app.config.globalProperties.emitter = emitter
  app.mount(host)
  await vi.waitFor(() => expect(findButton('macro.reorder').disabled).toBe(false))
}

beforeEach(() => {
  getMacrosCompact.mockReset()
  updateMacroOrder.mockReset()
  getMacrosCompact.mockResolvedValueOnce(listResponse(original))
})

afterEach(() => {
  app?.unmount()
  host?.remove()
})

describe('macro order', () => {
  it('saves the displayed order and refreshes from the server without losing the search term', async () => {
    updateMacroOrder.mockResolvedValue({ data: { data: true } })
    getMacrosCompact.mockResolvedValueOnce(listResponse(afterSave))
    await mount()

    const search = host.querySelector('input')
    search.value = 'Second'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    await click('macro.reorder')
    expect(sortRowNames()).toEqual(['First', 'Second'])
    expect(findButton('globals.messages.save').disabled).toBe(true)

    await click('macro.moveUp: Second')
    expect(sortRowNames()).toEqual(['Second', 'First'])
    await click('globals.messages.save')

    expect(updateMacroOrder).toHaveBeenCalledExactlyOnceWith([4, 7])
    await vi.waitFor(() =>
      expect(host.querySelector('[data-table]').textContent).toBe('Second, First, New macro')
    )
    expect(host.querySelector('input').value).toBe('Second')
  })

  it('keeps the pending order after a failed save and defers list refreshes until exiting', async () => {
    updateMacroOrder.mockRejectedValueOnce(new Error('network unavailable'))
    getMacrosCompact.mockResolvedValueOnce(listResponse(afterSave))
    await mount()
    await click('macro.reorder')
    await click('macro.moveDown: First')
    emitter.emit(EMITTER_EVENTS.REFRESH_LIST, { model: 'macros' })
    expect(getMacrosCompact).toHaveBeenCalledTimes(1)

    await click('globals.messages.save')
    await vi.waitFor(() => expect(findButton('globals.messages.save').disabled).toBe(false))
    expect(sortRowNames()).toEqual(['Second', 'First'])

    await click('globals.messages.cancel')
    await vi.waitFor(() => expect(getMacrosCompact).toHaveBeenCalledTimes(2))
    expect(host.querySelector('ol')).toBeNull()
  })

  it('distinguishes same-name macros by ID when ordering them', async () => {
    getMacrosCompact.mockReset().mockResolvedValueOnce(listResponse([
      { id: 1, name: 'Repeat' },
      { id: 2, name: 'Unique' },
      { id: 3, name: 'Repeat' }
    ]))
    await mount()
    await click('macro.reorder')

    expect(sortRowNames()).toEqual(['Repeat #1', 'Unique', 'Repeat #3'])
    expect(findButton('macro.moveUp: Repeat #1').disabled).toBe(true)
    await click('macro.moveUp: Repeat #3')
    expect(sortRowNames()).toEqual(['Repeat #1', 'Repeat #3', 'Unique'])
  })
})

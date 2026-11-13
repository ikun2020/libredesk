import { describe, expect, it, vi } from 'vitest'
import { createSuggestionRenderer } from './suggestionRenderer'

vi.mock('@tiptap/vue-3', () => ({ VueRenderer: vi.fn() }))

describe('createSuggestionRenderer', () => {
  it('reserves Enter while the active suggestion is still loading', () => {
    const renderer = createSuggestionRenderer({})

    expect(renderer.onKeyDown({ event: { key: 'Enter' } })).toBe(true)
    expect(renderer.onKeyDown({ event: { key: 'ArrowDown' } })).toBe(false)
    expect(renderer.onKeyDown({ event: { key: 'Escape' } })).toBe(true)
    expect(renderer.onKeyDown({ event: { key: 'Enter' } })).toBe(false)
  })
})

// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from 'vue'
import { createI18n } from 'vue-i18n'
import { Editor } from '@tiptap/vue-3'
import { buildConversationExtensions } from './editorExtensions'
import { MessageSend } from './messageSendExtension'

const editors = []

function createEditor({
  enabled = true,
  content = '<p>Reply draft</p>',
  getConversationSuggestions = () => [{ id: 'conversation-1', label: '108' }]
} = {}) {
  const element = document.createElement('div')
  document.body.appendChild(element)
  const onSend = vi.fn()
  const editor = new Editor({
    element,
    content,
    extensions: [
      ...buildConversationExtensions({ getPlaceholder: () => '' }),
      MessageSend.configure({ sendOnEnter: () => enabled, onSend })
    ],
    editorProps: {
      enableMentions: () => true,
      getSuggestions: () => [{ id: 'agent-1', type: 'agent', label: 'Ada' }],
      conversationReferencesEnabled: () => true,
      getConversationSuggestions,
      // JSDOM has no text layout; keep real keyboard dispatch and suggestion UI.
      handleScrollToSelection: () => true
    }
  })
  editor.appContext = createApp({})
    .use(createI18n({
      legacy: false, locale: 'en', messages: {}, missingWarn: false, fallbackWarn: false
    }))
    ._context
  editor.commands.setTextSelection(editor.state.doc.content.size - 1)
  editor.view.dom.focus()
  editors.push({ editor, element })
  return { editor, onSend }
}

function pressKey(editor, key = 'Enter', options = {}) {
  const event = new KeyboardEvent('keydown', {
    key,
    code: key,
    keyCode: key === 'Enter' ? 13 : 27,
    bubbles: true,
    cancelable: true,
    ...options
  })
  editor.view.dom.dispatchEvent(event)
  return event
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const { editor, element } of editors.splice(0)) {
    editor.destroy()
    element.remove()
  }
})

describe('message send keyboard extension', () => {
  it('sends plain Enter without changing the draft or inserting a paragraph', () => {
    const { editor, onSend } = createEditor()
    const original = editor.getJSON()

    expect(pressKey(editor).defaultPrevented).toBe(true)

    expect(onSend).toHaveBeenCalledOnce()
    expect(editor.getJSON()).toEqual(original)
  })

  it('keeps Shift+Enter as a newline and does not send Ctrl+Enter', () => {
    const { editor, onSend } = createEditor()

    pressKey(editor, 'Enter', { shiftKey: true })

    expect(onSend).not.toHaveBeenCalled()
    expect(editor.getJSON().content[0].content).toContainEqual({ type: 'hardBreak' })

    pressKey(editor, 'Enter', { ctrlKey: true })

    expect(onSend).not.toHaveBeenCalled()
  })

  it('does not repeatedly send or insert newlines while Enter is held', () => {
    const { editor, onSend } = createEditor()
    const original = editor.getJSON()

    pressKey(editor)
    pressKey(editor, 'Enter', { repeat: true })
    pressKey(editor, 'Enter', { repeat: true })

    expect(onSend).toHaveBeenCalledOnce()
    expect(editor.getJSON()).toEqual(original)
  })

  it.each([
    ['isComposing', { isComposing: true }],
    ['Safari keyCode 229', { keyCode: 229 }]
  ])('does not send Enter used by an IME (%s)', (_, options) => {
    const { editor, onSend } = createEditor()

    pressKey(editor, 'Enter', options)

    expect(onSend).not.toHaveBeenCalled()
  })

  it('does not send while the editor is still composing', () => {
    const { editor, onSend } = createEditor()
    vi.spyOn(editor.view, 'composing', 'get').mockReturnValue(true)

    pressKey(editor)

    expect(onSend).not.toHaveBeenCalled()
  })

  it('leaves ordinary Enter editing intact when sending is disabled', () => {
    const { editor, onSend } = createEditor({ enabled: false })

    pressKey(editor)

    expect(onSend).not.toHaveBeenCalled()
    expect(editor.getJSON().content).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'Reply draft' }] },
      { type: 'paragraph' }
    ])
  })

  it.each([
    ['@Ada', '.mention-item', 'mention', { id: 'agent-1', label: 'Ada' }],
    ['#108', '.conversation-reference-item', 'conversationReference', {
      id: 'conversation-1', label: '108'
    }]
  ])('selects the %s candidate before allowing the next Enter to send', async (query, selector, type, attrs) => {
    const { editor, onSend } = createEditor({ content: '<p></p>' })
    editor.commands.insertContent(query)
    await vi.waitFor(() => expect(document.querySelector(selector)).not.toBeNull())

    pressKey(editor)

    expect(onSend).not.toHaveBeenCalled()
    expect(editor.getJSON().content[0].content[0]).toMatchObject({ type, attrs })
    await vi.waitFor(() => expect(document.querySelector(selector)).toBeNull())

    pressKey(editor)

    expect(onSend).toHaveBeenCalledOnce()
  })

  it('does not send when the open conversation search has no results', async () => {
    const { editor, onSend } = createEditor({
      content: '<p></p>', getConversationSuggestions: () => []
    })
    editor.commands.insertContent('#missing')
    await vi.waitFor(() => expect(document.querySelector('.conversation-reference-list')).not.toBeNull())

    pressKey(editor)

    expect(onSend).not.toHaveBeenCalled()
    expect(editor.getJSON().content[0].content).toEqual([{ type: 'text', text: '#missing' }])
  })

  it('does not send while conversation candidates are still loading', async () => {
    let resolveCandidates
    const candidates = new Promise((resolve) => { resolveCandidates = resolve })
    const { editor, onSend } = createEditor({
      content: '<p></p>', getConversationSuggestions: () => candidates
    })
    editor.commands.insertContent('#108')
    expect(document.querySelector('.conversation-reference-list')).toBeNull()

    pressKey(editor)
    const sendCountWhileLoading = onSend.mock.calls.length
    // Let the real async suggestion lifecycle finish before the editor is destroyed.
    resolveCandidates([])
    await vi.waitFor(() => expect(document.querySelector('.conversation-reference-list')).not.toBeNull())

    expect(sendCountWhileLoading).toBe(0)
    expect(editor.getJSON().content[0].content).toEqual([{ type: 'text', text: '#108' }])
  })

  it.each([
    ['@Ada', '.mention-item'],
    ['#108', '.conversation-reference-item']
  ])('allows Enter to send after Escape dismisses %s candidates', async (query, selector) => {
    const { editor, onSend } = createEditor({ content: '<p></p>' })
    editor.commands.insertContent(query)
    await vi.waitFor(() => expect(document.querySelector(selector)).not.toBeNull())

    pressKey(editor, 'Escape')
    pressKey(editor)

    expect(onSend).toHaveBeenCalledOnce()
    expect(editor.getJSON().content[0].content).toEqual([{ type: 'text', text: query }])
  })
})

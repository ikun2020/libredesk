import { Extension } from '@tiptap/vue-3'
import { Plugin } from '@tiptap/pm/state'

export const MessageSend = Extension.create({
  name: 'messageSend',
  // Mention suggestions (101) must consume Enter before sending; send before
  // StarterKit's paragraph/list keymaps (100). Escape can still dismiss suggestions.
  priority: 100.5,

  addOptions() {
    return { sendOnEnter: () => false, onSend: () => {} }
  },

  addProseMirrorPlugins() {
    return [new Plugin({
      props: {
        handleKeyDown: (view, event) => {
          if (!this.options.sendOnEnter() || !this.editor.isEditable) return false
          if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) {
            return false
          }
          // Enter also confirms IME candidates. Safari may report keyCode 229
          // after isComposing has already become false.
          if (view.composing || event.isComposing || event.keyCode === 229) return false
          if (!event.repeat) this.options.onSend()
          return true
        }
      }
    })]
  }
})

import { readonly, ref } from 'vue'

// Explicitly enabled for this page session; never persisted or sent to a server.
const active = ref(false)

export function useViewportDiagnostics () {
  return {
    active: readonly(active),
    start: () => { active.value = true },
    stop: () => { active.value = false }
  }
}

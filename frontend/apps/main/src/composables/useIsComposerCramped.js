import { useMediaQuery } from '@vueuse/core'

// Touch devices need the keyboard-aware fullscreen composer even when unfolded.
// Never switch editors based on height: opening the keyboard can resize it.
export function useIsComposerCramped () {
  return useMediaQuery('(max-width: 767px), (pointer: coarse)')
}

import { computed } from 'vue'
import { useMediaQuery } from '@vueuse/core'

export const DUO_INNER_MIN_WIDTH = 800
export const DUO_INNER_MAX_WIDTH = 960

export function hasIPhoneDuoScreen() {
  if (!/\biPhone\b/.test(window.navigator.userAgent)) return false

  // The Duo PWA can report the outer screen through Screen even when unfolded.
  const { width, height } = window.screen
  const shortSide = Math.min(width, height)
  const longSide = Math.max(width, height)
  return (shortSide === 466 && longSide === 678) || (shortSide === 669 && longSide === 951)
}

export function useIPhoneDuoInbox() {
  const wideTouchViewport = useMediaQuery(
    `(min-width: ${DUO_INNER_MIN_WIDTH}px) and (max-width: ${DUO_INNER_MAX_WIDTH}px) and (pointer: coarse) and (resolution: 3dppx)`
  )
  const standalone = useMediaQuery('(display-mode: standalone)')

  return computed(() => wideTouchViewport.value &&
    (standalone.value || navigator.standalone === true) && hasIPhoneDuoScreen())
}

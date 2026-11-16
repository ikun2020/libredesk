import { computed } from 'vue'
import { useMediaQuery } from '@vueuse/core'

export function useIPhoneDuoInbox() {
  const wideTouchViewport = useMediaQuery(
    '(min-width: 800px) and (max-width: 960px) and (pointer: coarse) and (resolution: 3dppx)'
  )
  const standalone = useMediaQuery('(display-mode: standalone)')

  return computed(() => {
    if (!wideTouchViewport.value || (!standalone.value && !navigator.standalone)) return false
    if (!/\biPhone\b/.test(navigator.userAgent)) return false

    // The Duo PWA can still report the outer screen through Screen after unfolding.
    // Use the layout viewport query above for the actual space available to the app.
    const { width, height } = window.screen
    const shortSide = Math.min(width, height)
    const longSide = Math.max(width, height)
    return (shortSide === 466 && longSide === 678) || (shortSide === 669 && longSide === 951)
  })
}

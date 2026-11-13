import { onMounted, onUnmounted } from 'vue'

// The visual viewport tracks the space left above an overlay keyboard on iOS.
export function useVisualViewportHeight () {
  const viewport = window.visualViewport
  const property = '--visual-viewport-height'
  const rootStyle = document.documentElement.style
  const previousHeight = rootStyle.getPropertyValue(property)
  const update = () => {
    // Pinch zoom also shrinks visualViewport; keep the existing layout while zoomed.
    if (viewport?.scale && viewport.scale !== 1) return
    rootStyle.setProperty(property, `${viewport?.height || window.innerHeight}px`)
  }

  onMounted(() => {
    update()
    viewport?.addEventListener('resize', update)
    window.addEventListener('resize', update)
  })

  onUnmounted(() => {
    viewport?.removeEventListener('resize', update)
    window.removeEventListener('resize', update)
    if (previousHeight) rootStyle.setProperty(property, previousHeight)
    else rootStyle.removeProperty(property)
  })
}

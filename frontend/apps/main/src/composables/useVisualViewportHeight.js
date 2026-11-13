import { onMounted, onUnmounted } from 'vue'

// The visual viewport tracks the space left above an overlay keyboard on iOS.
export function useVisualViewportHeight () {
  const viewport = window.visualViewport
  const property = '--visual-viewport-height'
  const rootStyle = document.documentElement.style
  const previousHeight = rootStyle.getPropertyValue(property)
  let frame = null
  let timers = []

  const isStandaloneTouch = () =>
    (window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true) &&
    window.matchMedia('(pointer: coarse)').matches

  const fitsLayoutViewport = () => {
    // Some standalone resumes leave WebKit reporting a sub-unit scale even
    // though the visual and layout widths still match. Do not freeze the shell
    // at its pre-suspension height in that case. A real pinch/pan changes the
    // visible width or offsets; keep its layout unchanged.
    return viewport && viewport.scale > 0 && viewport.scale < 1 && isStandaloneTouch() &&
      Number.isFinite(viewport.width) && viewport.width > 0 &&
      Math.abs(viewport.width - window.innerWidth) < 1 &&
      Math.abs(viewport.width - document.documentElement.clientWidth) < 1 &&
      viewport.offsetTop === 0 && viewport.offsetLeft === 0
  }

  const update = () => {
    // Suspended documents can report zero or stale viewport dimensions.
    if (document.hidden) return false
    // Pinch zoom also shrinks visualViewport; keep the existing layout while zoomed.
    if (viewport && viewport.scale !== 1 && !fitsLayoutViewport()) return false
    const height = viewport ? viewport.height : window.innerHeight
    if (!Number.isFinite(height) || height <= 0) return false
    rootStyle.setProperty(property, `${height}px`)
    return true
  }

  const restore = () => {
    if (!update()) return

    // Updating a matching shell height does not authorize resetting zoom/pan.
    if ((viewport && viewport.scale !== 1) || !isStandaloneTouch()) return

    // The app scrolls its inner panes, not the document. iOS can restore a
    // displaced root scroll position after resuming a standalone window. Do not
    // fight keyboard panning or touch any pane's scroll, focus, or draft.
    const active = document.activeElement
    if (active?.matches('input, textarea, select, [role="textbox"]') ||
      active?.isContentEditable || active?.closest('[contenteditable="true"]')) return
    if (window.scrollX !== 0 || window.scrollY !== 0) {
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
    }
  }

  const cancelRestore = () => {
    if (frame !== null) window.cancelAnimationFrame(frame)
    frame = null
    timers.forEach(timer => window.clearTimeout(timer))
    timers = []
  }

  const resume = () => {
    cancelRestore()
    if (document.hidden) return
    restore()
    // WebKit may settle its viewport after the lifecycle event without firing
    // resize. Re-read for a bounded period, cancelling when hidden/unmounted.
    frame = window.requestAnimationFrame(() => {
      frame = null
      restore()
    })
    timers = [250, 750].map(delay => window.setTimeout(restore, delay))
  }

  onMounted(() => {
    resume()
    viewport?.addEventListener('resize', update)
    viewport?.addEventListener('scroll', update)
    window.addEventListener('resize', resume)
    window.addEventListener('pageshow', resume)
    window.addEventListener('focus', resume)
    window.addEventListener('orientationchange', resume)
    document.addEventListener('visibilitychange', resume)
  })

  onUnmounted(() => {
    cancelRestore()
    viewport?.removeEventListener('resize', update)
    viewport?.removeEventListener('scroll', update)
    window.removeEventListener('resize', resume)
    window.removeEventListener('pageshow', resume)
    window.removeEventListener('focus', resume)
    window.removeEventListener('orientationchange', resume)
    document.removeEventListener('visibilitychange', resume)
    if (previousHeight) rootStyle.setProperty(property, previousHeight)
    else rootStyle.removeProperty(property)
  })
}

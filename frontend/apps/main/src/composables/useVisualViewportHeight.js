import { onMounted, onUnmounted } from 'vue'

// The visual viewport tracks the space left above an overlay keyboard on iOS.
export function useVisualViewportHeight () {
  const viewport = window.visualViewport
  const property = '--visual-viewport-height'
  const topProperty = '--visual-viewport-page-top'
  const rootStyle = document.documentElement.style
  const previousHeight = rootStyle.getPropertyValue(property)
  const previousTop = rootStyle.getPropertyValue(topProperty)
  let keyboardTop = 0
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

  const isEditable = element => Boolean(
    element?.matches('input, textarea, select, [role="textbox"]') ||
    element?.isContentEditable || element?.closest('[contenteditable="true"], [contenteditable=""]')
  )

  const updateKeyboardTop = height => {
    const active = document.activeElement
    const editing = isEditable(active)
    const editingShell = editing && document.querySelector('.app-shell')?.contains(active)
    // Keep the current origin during keyboard dismissal, when focus can leave
    // the editor before the viewport expands. A body-portal editor must not
    // reposition the background shell.
    const followsKeyboard = editingShell || (keyboardTop > 0 && !editing)
    keyboardTop = viewport?.scale === 1 && window.matchMedia('(pointer: coarse)').matches &&
      height < document.documentElement.clientHeight && followsKeyboard &&
      Number.isFinite(viewport.pageTop) ? Math.max(0, viewport.pageTop) : 0
    // The wrapper reserves this space in normal flow, including in its parent's
    // height. pageTop is already a document coordinate; do not add scrollY or
    // offsetTop and count WebKit's keyboard pan twice.
    rootStyle.setProperty(topProperty, `${keyboardTop}px`)
  }

  const update = () => {
    // Suspended documents can report zero or stale viewport dimensions.
    if (document.hidden) return false
    // Pinch zoom also shrinks visualViewport; keep the existing layout while zoomed.
    if (viewport && viewport.scale !== 1 && !fitsLayoutViewport()) return false
    const height = viewport ? viewport.height : window.innerHeight
    if (!Number.isFinite(height) || height <= 0) return false
    rootStyle.setProperty(property, `${height}px`)
    updateKeyboardTop(height)
    return true
  }

  const restore = () => {
    if (!update()) return

    // Updating a matching shell height does not authorize resetting zoom/pan.
    if ((viewport && viewport.scale !== 1) || !isStandaloneTouch()) return

    // The app scrolls its inner panes, not the document. iOS can restore a
    // displaced root scroll position after resuming a standalone window. Do not
    // fight keyboard panning or touch any pane's scroll, focus, or draft.
    if (isEditable(document.activeElement) || keyboardTop > 0) return
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
    document.addEventListener('focusin', update)
    document.addEventListener('focusout', update)
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
    document.removeEventListener('focusin', update)
    document.removeEventListener('focusout', update)
    if (previousHeight) rootStyle.setProperty(property, previousHeight)
    else rootStyle.removeProperty(property)
    if (previousTop) rootStyle.setProperty(topProperty, previousTop)
    else rootStyle.removeProperty(topProperty)
  })
}

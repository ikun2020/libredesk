let detailLoad

export function loadConversationDetail () {
  detailLoad ??= import('@main/views/conversation/ConversationDetailView.vue').catch(error => {
    detailLoad = undefined
    throw error
  })
  return detailLoad
}

export function scheduleConversationDetailPreload (isReady) {
  if (detailLoad) return () => {}

  let cancelIdle = () => {}
  // Let the inbox paint before asking the browser for idle time.
  let frame = window.requestAnimationFrame(() => {
    frame = window.requestAnimationFrame(() => {
      const preload = () => {
        if (isReady()) void loadConversationDetail().catch(() => {})
      }
      if (typeof window.requestIdleCallback === 'function') {
        const task = window.requestIdleCallback(preload)
        cancelIdle = () => window.cancelIdleCallback(task)
      } else {
        const task = window.setTimeout(preload, 500)
        cancelIdle = () => window.clearTimeout(task)
      }
    })
  })

  return () => {
    window.cancelAnimationFrame(frame)
    cancelIdle()
  }
}

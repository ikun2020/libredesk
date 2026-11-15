export async function updateAppBadge(hasUnread, browserNavigator = globalThis.navigator) {
  try {
    if (hasUnread) {
      await browserNavigator?.setAppBadge?.()
    } else {
      await browserNavigator?.clearAppBadge?.()
    }
  } catch {
    // The browser or operating system may prevent badging.
  }
}

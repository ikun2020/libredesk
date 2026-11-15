const readPayload = (event) => {
  try {
    return event.data ? event.data.json() : null
  } catch {
    return null
  }
}

self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('push', (event) => {
  const notification = readPayload(event)
  if (!notification?.title) return
  const showNotification = self.registration.showNotification(notification.title, {
    body: notification.body,
    tag: notification.tag,
    icon: '/images/pwa-icon-192.png',
    badge: '/images/pwa-icon-192.png',
    data: { url: notification.url }
  })
  const showAppBadge = Promise.resolve().then(() => self.navigator?.setAppBadge?.()).catch(() => {})
  event.waitUntil(Promise.all([showNotification, showAppBadge]))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = event.notification.data?.url
  if (!url) return
  const target = new URL(url, self.location.origin)
  if (target.origin !== self.location.origin) return

  // Let the browser route the conversation to the installed app.
  event.waitUntil(self.clients.openWindow(target.href))
})

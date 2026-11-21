/*
 * The service worker of nexnotes: notifications (NOTES-14). It shows what the server sent, encrypted for this browser
 * and decrypted by it, and a tap opens the note: in a window of nexnotes that is open already, or in a new one. It keeps
 * nothing and answers no request.
 */
'use strict'

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

/** Only an address inside nexnotes, never another site. */
function inside(url) {
  return typeof url === 'string' && url.startsWith('/') && !url.startsWith('//') ? url : '/'
}

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = {}
  }
  const title = typeof data.title === 'string' && data.title ? data.title : 'nexnotes'
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof data.body === 'string' ? data.body : '',
      tag: typeof data.tag === 'string' ? data.tag : undefined,
      icon: '/logo.svg',
      data: { url: inside(data.url) },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const path = inside(event.notification.data && event.notification.data.url)
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue
        await client.focus()
        client.postMessage({ type: 'nexnotes-open', url: path })
        return
      }
      await self.clients.openWindow(path)
    })(),
  )
})

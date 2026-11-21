/*
 * The service worker of nexnotes.
 *
 * Notifications (NOTES-14): it shows what the server sent, encrypted for this browser and decrypted by it, and a tap
 * opens the note: in a window of nexnotes that is open already, or in a new one.
 *
 * The installable web app (NOTES-23):
 *  - The shell. The build writes its own stamp and the list of its files into this file (vite.config.ts, plugin
 *    "service-worker"), so every build is a new worker. It keeps the start page and the built files, so the installed
 *    app opens without the network and says "No connection" instead of the browser's error page. Without a build
 *    (Vite's dev server) nothing is kept.
 *    - Pages (every navigation): the network first; the kept start page only without network, when the server is down
 *      (502, 503, 504) or after PAGE_WAIT. Only an answer the server marks as the start page (X-Nexnotes-Shell: 1) is
 *      kept, so a page drawn by the server with a note in it (a read link, /l/...) never is.
 *    - Built files under /assets/ (their names carry a hash and never change): the kept one first.
 *    - The few files of the shell without a hash (symbols, manifest, theme.js, logo): the network first.
 *    - /api/..., /l/... and every other address: never touched, never kept. Notes never outlive the page.
 *    Only answers of the own origin, of type "basic", not redirected, 200, without "no-store", are kept. Older caches
 *    go when a new worker takes over; the first worker takes over at once, a later one when the page says so ("New
 *    version, reload").
 *  - Sharing from Android (Web Share Target, manifest "share_target"). The POST to /share-target is taken here, never by
 *    the server: what was shared stays in this worker's memory only, under a random id for at most SHARE_KEEP_MS, and
 *    the page "Save to nexnotes" (/share?shared=<id>) takes it over a MessageChannel. It is gone after "Save" or
 *    "Cancel", when the account signs out or changes, and when the time runs out.
 *  - Signing out and another account in the tab send "nexnotes-forget": the shared things go, and every entry of the
 *    cache that is not a file of the shell.
 */
'use strict'

const VERSION = '__NEXNOTES_BUILD__'
const SHELL = /* __NEXNOTES_SHELL__ */ []
const BUILT = !VERSION.startsWith('__')
const PREFIX = 'nexnotes-shell-'
const CACHE = PREFIX + VERSION
/** The start page, the same for every address of the app. */
const START = '/index.html'
/** How long a page may take before the kept start page shows. */
const PAGE_WAIT = 4000
/** The server's mark on the start page: the one answer to a navigation that may be kept. */
const SHELL_HEADER = 'x-nexnotes-shell'
/** Addresses never touched: the API, and the read links the server draws with a note in them. */
const NEVER = ['/api', '/l']
/** A proxy's answers while the server is down. */
const DOWN = [502, 503, 504]

const SHARE_PATH = '/share-target'
const SHARE_PAGE = '/share'
/** What was shared waits this long for its page (below the browsers' limit for one event). */
const SHARE_KEEP_MS = 4 * 60 * 1000
const SHARE_MAX_FILES = 20
const SHARE_MAX_TEXT = 200000

// ---- What happens to a request -----------------------------------------------------------------------------------------

/** `share` (the share target's POST), `page`, `asset`, `file`, or `network` (not touched here). */
function strategy(request, origin, built) {
  const url = new URL(request.url)
  if (url.origin !== origin) return 'network'
  if (request.method === 'POST' && url.pathname === SHARE_PATH) return 'share'
  if (request.method !== 'GET') return 'network'
  if (NEVER.some((path) => url.pathname === path || url.pathname.startsWith(path + '/'))) return 'network'
  if (!built || url.pathname === '/sw.js') return 'network'
  if (request.mode === 'navigate') return 'page'
  if (url.pathname.startsWith('/assets/')) return 'asset'
  if (SHELL.includes(url.pathname)) return 'file'
  return 'network'
}

/** Whether an answer may be kept: the own origin's, whole, not redirected, not forbidden to keep. A page only when the
 * server marked it as the start page; a file never as a page (the start page the server gives for a missing file). */
function keepable(response, kind) {
  if (!response || response.status !== 200 || response.type !== 'basic' || response.redirected) return false
  if (/no-store/i.test(response.headers.get('cache-control') || '')) return false
  const type = response.headers.get('content-type') || ''
  if (kind === 'page') return response.headers.get(SHELL_HEADER) === '1' && type.includes('text/html')
  return !type.includes('text/html')
}

/** Whether an entry of the cache belongs to the shell; anything else goes when the account signs out. */
function shellEntry(url) {
  const path = new URL(url).pathname
  return path === START || path.startsWith('/assets/') || SHELL.includes(path)
}

async function keep(key, response, kind) {
  if (!keepable(response, kind)) return false
  const cache = await caches.open(CACHE)
  await cache.put(key, response)
  return true
}

/** Waits `ms`, then gives `value`; never when `ms` is null. */
function after(ms, value) {
  return ms === null ? new Promise(() => {}) : new Promise((resolve) => setTimeout(() => resolve(value), ms))
}

async function page(request) {
  const kept = await caches.match(START)
  const network = fetch(request).then(async (response) => {
    await keep(START, response.clone(), 'page').catch(() => false)
    return response
  })
  if (!kept) return network
  const answer = network.then((response) => (DOWN.includes(response.status) ? kept : response)).catch(() => kept)
  return Promise.race([answer, after(PAGE_WAIT, kept)])
}

async function asset(request) {
  const kept = await caches.match(request)
  if (kept) return kept
  const response = await fetch(request)
  await keep(request, response.clone(), 'asset').catch(() => false)
  return response
}

async function file(request) {
  try {
    const response = await fetch(request)
    await keep(request, response.clone(), 'file').catch(() => false)
    return response
  } catch (error) {
    const kept = await caches.match(request, { ignoreSearch: true })
    if (kept) return kept
    throw error
  }
}

// ---- Shared from another app (Web Share Target) ----------------------------------------------------------------------

/** What the form of the share target carries, checked: texts cut to size, an address only http(s), files only files. */
function readShare(form) {
  const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '')
  let url = text(form.get('url'), 4000).trim()
  if (!/^https?:\/\/\S+$/i.test(url)) url = ''
  // A file field with nothing chosen still sends one part: no name, no bytes. That is no file.
  const files = form
    .getAll('files')
    .filter((item) => item && typeof item === 'object' && typeof item.size === 'number' && typeof item.name === 'string')
    .filter((item) => item.name !== '' || item.size > 0)
    .slice(0, SHARE_MAX_FILES)
  return { title: text(form.get('title'), 1000), text: text(form.get('text'), SHARE_MAX_TEXT), url, files }
}

/** 128 random bits, as hex: the only way to what was shared. */
function shareId() {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** What was shared, by id, while it waits for its page. Memory only. */
const shared = new Map()

/** Keeps `entry` under `id` until it is released (taken and done, forgotten, or after `ms`). Returns a promise that
 * settles on release: the share event waits for it, so the worker stays while something waits. */
function stash(store, id, entry, ms) {
  let release
  const until = new Promise((resolve) => {
    release = resolve
  })
  const timer = setTimeout(() => drop(store, id), ms)
  store.set(id, { entry, release: () => (clearTimeout(timer), release()) })
  return until
}

function drop(store, id) {
  const held = store.get(id)
  if (!held) return false
  store.delete(id)
  held.release()
  return true
}

function dropAll(store) {
  for (const id of [...store.keys()]) drop(store, id)
}

function take(store, id) {
  const held = typeof id === 'string' ? store.get(id) : undefined
  return held ? held.entry : null
}

/** The page "Save to nexnotes" for what was shared under `id`, as a whole address of the own origin. */
function sharePage(id) {
  return new URL(SHARE_PAGE + '?shared=' + encodeURIComponent(id), self.location.origin).href
}

async function share(event) {
  let entry
  try {
    entry = readShare(await event.request.formData())
  } catch {
    return Response.redirect(sharePage('lost'), 303)
  }
  const id = shareId()
  event.waitUntil(stash(shared, id, entry, SHARE_KEEP_MS))
  return Response.redirect(sharePage(id), 303)
}

/** Every entry of the cache outside the shell goes (signing out, another account). */
async function forgetForeign() {
  for (const name of await caches.keys()) {
    if (!name.startsWith(PREFIX)) continue
    const cache = await caches.open(name)
    for (const request of await cache.keys()) if (!shellEntry(request.url)) await cache.delete(request)
  }
}

// ---- Events ----------------------------------------------------------------------------------------------------------

self.addEventListener('fetch', (event) => {
  const how = strategy(event.request, self.location.origin, BUILT)
  if (how === 'network') return
  if (how === 'share') return event.respondWith(share(event))
  event.respondWith(how === 'page' ? page(event.request) : how === 'asset' ? asset(event.request) : file(event.request))
})

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      if (BUILT) {
        // One by one and checked like every other answer: a proxy that sends the sign-in of another site instead of
        // the start page leaves the cache empty, never wrong.
        await Promise.allSettled(
          [START, ...SHELL].map(async (path) => {
            const response = await fetch(new Request(path, { cache: 'reload' }))
            await keep(path, response, path === START ? 'page' : path.startsWith('/assets/') ? 'asset' : 'file')
          }),
        )
      }
      // The first worker takes over at once; a new one waits until the page says "reload" (or every tab is closed),
      // so a page open while writing never loses the files of its own build.
      if (!self.registration.active) await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(names.filter((name) => name.startsWith(PREFIX) && name !== CACHE).map((name) => caches.delete(name)))
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('message', (event) => {
  const data = event.data || {}
  const port = event.ports && event.ports[0]
  if (data.type === 'nexnotes-update') return void self.skipWaiting()
  // Which build this worker holds: the page takes it over silently when it is its own (a hard reload passed it by).
  if (data.type === 'nexnotes-shell' && port) return void port.postMessage({ version: VERSION, shell: SHELL })
  if (data.type === 'nexnotes-share-take' && port) return void port.postMessage(take(shared, data.id))
  if (data.type === 'nexnotes-share-done') return void drop(shared, data.id)
  if (data.type === 'nexnotes-forget') {
    dropAll(shared)
    if (event.waitUntil) event.waitUntil(forgetForeign())
  }
})

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

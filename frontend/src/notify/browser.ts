/**
 * This browser and Web Push (NOTES-14 AC-7, EC-3): the service worker (`public/sw.js`), the browser's permission, and
 * the sign-up at the server. The permission is the browser's own and holds per browser; the sign-up belongs to the
 * session, so after signing in again the page signs the browser up by itself while the permission stands.
 */
import { notifyApi } from './api'

/** `on`: notifications come here; `off`: they could, nobody allowed them yet; `denied`: the browser refuses them;
 * `unsupported`: this browser cannot (an iPhone's Safari outside an installed web app, an old browser). */
export type BrowserState = 'on' | 'off' | 'denied' | 'unsupported'

export function pushSupported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

let registering: Promise<ServiceWorkerRegistration> | null = null

export function worker(): Promise<ServiceWorkerRegistration> {
  if (!registering) registering = navigator.serviceWorker.register('/sw.js', { scope: '/' })
  return registering
}

/** For the tests: the next call registers again. */
export function forgetWorker(): void {
  registering = null
  subscribed = null
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (base64url.length % 4)) % 4)
  const raw = atob(padded)
  const out = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

function asSubscription(subscription: PushSubscription) {
  const json = subscription.toJSON()
  return { endpoint: subscription.endpoint, keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' } }
}

/** Whether this browser is signed up at the server (asked once per page, then kept). */
let subscribed: Promise<boolean> | null = null

export function browserSubscribed(): Promise<boolean> {
  if (!subscribed) subscribed = notifyApi.webpush().then((state) => state.subscribed, () => false)
  return subscribed
}

export async function browserState(): Promise<BrowserState> {
  if (!pushSupported()) return 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  if (Notification.permission !== 'granted') return 'off'
  return (await browserSubscribed()) ? 'on' : 'off'
}

/** "Erlauben": asks the browser, then signs it up. `denied` when the browser (or the person) said no (EC-3). */
export async function allowBrowser(): Promise<BrowserState> {
  if (!pushSupported()) return 'unsupported'
  const answer = await Notification.requestPermission()
  if (answer === 'denied') return 'denied'
  if (answer !== 'granted') return 'off'
  const registration = await worker()
  const { key } = await notifyApi.webpush()
  let subscription = await registration.pushManager.getSubscription()
  if (subscription && subscription.options?.applicationServerKey) {
    // Made for another key (a server that lost its secret): a new one for this server's.
    const before = new Uint8Array(subscription.options.applicationServerKey)
    const now = keyBytes(key)
    if (before.length !== now.length || before.some((byte, i) => byte !== now[i])) {
      await subscription.unsubscribe()
      subscription = null
    }
  }
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) })
  await notifyApi.subscribe(asSubscription(subscription))
  subscribed = Promise.resolve(true)
  return 'on'
}

/** Notifications off for this browser: the server forgets it, the browser's subscription goes. */
export async function stopBrowser(): Promise<BrowserState> {
  await notifyApi.unsubscribe()
  subscribed = Promise.resolve(false)
  if (pushSupported()) {
    const registration = await navigator.serviceWorker.getRegistration('/')
    const subscription = await registration?.pushManager.getSubscription()
    await subscription?.unsubscribe()
  }
  return pushSupported() ? 'off' : 'unsupported'
}

/** At the start of the signed-in app: a browser that allowed notifications before but whose sign-up ended with its
 * session (a new sign-in) is signed up again, without asking anything. */
export async function renewBrowser(): Promise<void> {
  if (!pushSupported() || Notification.permission !== 'granted') return
  const registration = await worker()
  const subscription = await registration.pushManager.getSubscription()
  if (!subscription || (await browserSubscribed())) return
  await notifyApi.subscribe(asSubscription(subscription))
  subscribed = Promise.resolve(true)
}

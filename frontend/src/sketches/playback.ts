/**
 * What all recordings of a page share (NOTES-18): the speed, chosen once per device (AC-5), and that only one plays at
 * a time (EC-4). Nothing of it is in the note: somebody else playing the same recording hears it on their own (EC-7).
 */
import { useSyncExternalStore } from 'react'

export const RATES = [1, 1.5, 2] as const
export type Rate = (typeof RATES)[number]
export const RATE_KEY = 'nexnotes.recording.rate'

const listeners = new Set<() => void>()

function read(): Rate {
  try {
    const stored = Number(window.localStorage.getItem(RATE_KEY))
    return (RATES as readonly number[]).includes(stored) ? (stored as Rate) : 1
  } catch {
    return 1
  }
}

let rate: Rate = read()

export function currentRate(): Rate {
  return rate
}

export function setRate(next: Rate): void {
  rate = next
  try {
    window.localStorage.setItem(RATE_KEY, String(next))
  } catch {
    // A browser without storage keeps it for this page only.
  }
  for (const listener of listeners) listener()
}

/** Reads the device's choice again (another tab changed it, or a test cleared it). */
export function reloadRate(): void {
  rate = read()
  for (const listener of listeners) listener()
}

export function useRate(): Rate {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => rate,
  )
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === RATE_KEY) reloadRate()
  })
}

// --- One at a time ------------------------------------------------------------------------------------------------------

let playing: HTMLMediaElement | null = null

/** `media` starts: whatever played before stops. */
export function claim(media: HTMLMediaElement): void {
  if (playing && playing !== media && !playing.paused) playing.pause()
  playing = media
}

export function release(media: HTMLMediaElement): void {
  if (playing === media) playing = null
}

/** A length as the player shows it: `m:ss`, from an hour on `h:mm:ss`. */
export function clock(ms: number): string {
  const seconds = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = String(seconds % 60).padStart(2, '0')
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`
}

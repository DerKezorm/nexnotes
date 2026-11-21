/** A tab brought to the front by a choice in a menu pulses in honey for a moment, so one sees where it is. */
import { useEffect, useState } from 'react'

const PULSE_EVENT = 'nexnotes:pulse-tab'
/** How long it pulses. */
export const PULSE_MS = 1200

export function pulseTab(key: string): void {
  window.dispatchEvent(new CustomEvent(PULSE_EVENT, { detail: key }))
}

/** The key of the tab pulsing now, if any. */
export function usePulsingTab(): string | null {
  const [pulsing, setPulsing] = useState<string | null>(null)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const start = (event: Event) => {
      setPulsing((event as CustomEvent<string>).detail)
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => setPulsing(null), PULSE_MS)
    }
    window.addEventListener(PULSE_EVENT, start)
    return () => {
      window.removeEventListener(PULSE_EVENT, start)
      if (timer) clearTimeout(timer)
    }
  }, [])
  return pulsing
}

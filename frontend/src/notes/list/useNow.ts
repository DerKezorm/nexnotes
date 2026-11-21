/**
 * "Now" for the date groups of a list, renewed just after every local midnight and whenever the page comes back into
 * sight (a laptop woken the next morning): a note changed before midnight moves from "Heute" to "Gestern" while the
 * list stays open (EC-7). The device's time zone counts.
 */
import { useEffect, useState } from 'react'

import { untilMidnight } from './order'

export function useNow(): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = setTimeout(() => setNow(new Date()), untilMidnight(now))
    return () => clearTimeout(timer)
  }, [now])
  useEffect(() => {
    const again = () => {
      if (document.visibilityState !== 'hidden') setNow(new Date())
    }
    document.addEventListener('visibilitychange', again)
    window.addEventListener('focus', again)
    return () => {
      document.removeEventListener('visibilitychange', again)
      window.removeEventListener('focus', again)
    }
  }, [])
  return now
}

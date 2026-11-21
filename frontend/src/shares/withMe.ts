/** "Mit mir geteilt" as data for the page and the sidebar's count, and the sentence of a notice (NOTES-13). */
import { useCallback, useEffect, useState } from 'react'

import { problemText } from '../lib/errors'
import { SHARES_CHANGED_EVENT, sharesApi, type ShareNotice, type WithMe } from './api'

/** "Mit mir geteilt" as data, loaded again whenever sharing changed here (and every half minute while seen). */
export function useWithMe(): { data: WithMe | null; problem: string; reload: () => void } {
  const [data, setData] = useState<WithMe | null>(null)
  const [problem, setProblem] = useState('')
  const reload = useCallback(() => {
    sharesApi.withMe().then(
      (found) => {
        setData(found)
        setProblem('')
      },
      (error) => setProblem(problemText(error)),
    )
  }, [])
  useEffect(() => {
    reload()
    window.addEventListener(SHARES_CHANGED_EVENT, reload)
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') reload()
    }, 30_000)
    return () => {
      window.removeEventListener(SHARES_CHANGED_EVENT, reload)
      clearInterval(timer)
    }
  }, [reload])
  return { data, problem, reload }
}

export function noticeText(notice: ShareNotice, t: (key: string, values?: Record<string, unknown>) => string): string {
  const title = notice.title || t('notes.untitled')
  return notice.reason === 'owner_gone' ? t('shares.ownerGone', { title, name: notice.owner }) : t('shares.ended', { title, name: notice.owner })
}

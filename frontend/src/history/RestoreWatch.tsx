/**
 * In an open note: when somebody restores an older version, the text follows live like every change; this tells the
 * person so (NOTES-15 EC-2). It learns the newest restore when the note opens, and after changes from others asks the
 * server again, a moment later: a newer one gets a notice with who and which version.
 */
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type * as Y from 'yjs'

import { showNotice } from '../folders/notice'
import { moment } from '../lib/time'
import { historyApi } from './api'
import { whoText } from './groups'

/** How long after the last change of others the server is asked. */
export const WATCH_DELAY_MS = 1200

export function RestoreWatch({ noteId, doc, origin }: { noteId: string; doc: Y.Doc; origin: unknown }) {
  const { t, i18n } = useTranslation()
  const words = useRef({ t, lang: i18n.language })
  useEffect(() => {
    words.current = { t, lang: i18n.language }
  }, [t, i18n.language])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let live = true
    // The newest restore when the note opened (undefined until known): only one after it is news.
    let known: number | null | undefined
    const ask = () => historyApi.lastRestore(noteId).then(({ last }) => last)
    void ask()
      .then((last) => {
        if (known === undefined) known = last?.id ?? null
      })
      .catch(() => {
        if (known === undefined) known = null
      })
    const look = () => {
      void ask()
        .then((last) => {
          if (!live || !last || known === undefined || last.id === known) return
          known = last.id
          const { t: say, lang } = words.current
          showNotice({ text: say('history.restoredBy', { name: whoText(last.authors, say) || say('history.someone'), when: moment(last.version_at, lang) }) })
        })
        .catch(() => undefined)
    }
    const onUpdate = (_update: Uint8Array, from: unknown) => {
      if (from !== origin) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(look, WATCH_DELAY_MS)
    }
    doc.on('update', onUpdate)
    return () => {
      live = false
      doc.off('update', onUpdate)
      if (timer) clearTimeout(timer)
    }
  }, [noteId, doc, origin])
  return null
}

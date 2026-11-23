/** The notice itself, drawn by the root `notice.ts` puts on the page. */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { problemText } from '../lib/errors'
import { hideNotice, showNotice, useNotice } from './notice'

export function NoticeHost() {
  const { t } = useTranslation()
  const shown = useNotice()
  const [busy, setBusy] = useState(false)
  useEffect(() => setBusy(false), [shown?.key])
  if (!shown) return null
  const undo = async () => {
    if (!shown.undo || busy) return
    setBusy(true)
    try {
      const said = await shown.undo()
      if (said) showNotice({ text: said })
      else hideNotice()
    } catch (problem) {
      showNotice({ text: problemText(problem) })
    }
  }
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-[60] flex justify-center px-4">
      <div
        role="status"
        data-testid="folder-notice"
        className="pointer-events-auto flex max-w-full items-center gap-3 rounded-[12px] border border-ink-600 bg-ink-800 py-2.5 pr-3 pl-4 text-[13.5px] text-mist-100 shadow-xl shadow-black/50"
      >
        <span className="min-w-0">{shown.text}</span>
        {shown.undo && (
          <button type="button" onClick={() => void undo()} disabled={busy} className="shrink-0 rounded-md px-2 py-1 font-semibold text-accent-400 not-disabled:hover:bg-ink-700">
            {t('folders.trash.undo')}
          </button>
        )}
      </div>
    </div>
  )
}


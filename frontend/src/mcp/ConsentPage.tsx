/**
 * `/oauth/authorize`: a program asks to connect as the signed-in member (NOTES-20 AC-7). The member chooses "read
 * only" or "read and write" and allows or denies; either way the browser goes back to the program's own address, which
 * the server checked against what the program registered.
 */
import { Bot } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'react-router-dom'

import { Problem } from '../components/Field'
import { problemText } from '../lib/errors'
import { consentAsk, leave, mcpApi, type McpLevel } from './api'

export function ConsentPage() {
  const { t } = useTranslation()
  const location = useLocation()
  const ask = consentAsk(location.search)
  const [info, setInfo] = useState<{ client_name: string; redirect_host: string } | null>(null)
  const [problem, setProblem] = useState(ask ? '' : t('mcp.consent.broken'))
  const [level, setLevel] = useState<McpLevel>('read')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!ask) return
    mcpApi.consentInfo(ask).then(setInfo, (error) => setProblem(problemText(error)))
    // The address does not change while the page is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search])

  const answer = async (approve: boolean) => {
    if (!ask || busy) return
    setBusy(true)
    setProblem('')
    try {
      const { redirect } = await mcpApi.consent(ask, approve, level)
      leave.to(redirect)
    } catch (error) {
      setProblem(problemText(error))
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto w-full max-w-md p-6">
      <section className="space-y-4 rounded-[16px] border border-ink-700 bg-ink-850 p-6" data-testid="mcp-consent">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--color-accent-wash)] text-accent-400">
          <Bot className="h-5 w-5" aria-hidden />
        </span>
        {info && (
          <>
            <h1 className="text-lg font-semibold text-mist-100">{t('mcp.consent.title', { name: info.client_name })}</h1>
            <p className="text-sm text-mist-400">{t('mcp.consent.text', { host: info.redirect_host })}</p>
            <fieldset className="space-y-2">
              <legend className="sr-only">{t('mcp.dialog.right')}</legend>
              {(['read', 'write'] as const).map((choice) => (
                <label key={choice} className="flex cursor-pointer gap-3 rounded-[12px] border border-ink-700 bg-ink-900 px-3 py-2.5">
                  <input
                    type="radio"
                    name="consent-level"
                    value={choice}
                    checked={level === choice}
                    onChange={() => setLevel(choice)}
                    className="mt-1 accent-[var(--color-accent-500)]"
                    data-testid={`consent-level-${choice}`}
                  />
                  <span>
                    <span className="block text-sm text-mist-100">{t(`mcp.dialog.${choice}`)}</span>
                    <span className="block text-xs text-mist-500">{t(`mcp.dialog.${choice}Hint`)}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <p className="text-xs text-mist-500">{t('mcp.consent.later')}</p>
          </>
        )}
        <Problem text={problem} />
        {info && (
          <div className="flex justify-end gap-2">
            <button type="button" className="nn-btn nn-btn-ghost" disabled={busy} onClick={() => void answer(false)} data-testid="consent-deny">
              {t('mcp.consent.deny')}
            </button>
            <button type="button" className="nn-btn nn-btn-accent" disabled={busy} onClick={() => void answer(true)} data-testid="consent-allow">
              {t('mcp.consent.allow')}
            </button>
          </div>
        )}
      </section>
    </div>
  )
}

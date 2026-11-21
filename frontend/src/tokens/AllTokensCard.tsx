/**
 * Server, Accounts: "API-Token aller Konten" (NOTES-25 AC-27). Per token the account, name, right, access, the number
 * of its folders, run-out and last use; never the token, never a title or a text. "Sperren" ends one at once; the
 * member then sees it as "Vom Betreiber gesperrt".
 */
import { KeyRound } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Problem } from '../components/Field'
import { problemText } from '../lib/errors'
import { day } from '../lib/format'
import { ago } from '../lib/time'
import { Card, Confirm } from '../pages/settings/ui'
import { expiry, tokensApi, type OperatorToken } from './api'

export function AllTokensCard() {
  const { t, i18n } = useTranslation()
  const [rows, setRows] = useState<OperatorToken[] | null>(null)
  const [problem, setProblem] = useState('')
  const [blocking, setBlocking] = useState<OperatorToken | null>(null)

  const load = useCallback(() => tokensApi.every().then((found) => setRows(found.tokens), (error) => setProblem(problemText(error))), [])
  useEffect(() => {
    void load()
  }, [load])

  const describe = (row: OperatorToken) => {
    const runs = expiry(row)
    const access = row.legacy ? t(`tokens.legacy.${row.legacy}`) : row.access.map((part) => t(`tokens.access.${part}`)).join(' · ')
    const folders = row.folders ? t('tokens.list.folders', { count: row.folders }) : t('tokens.list.foldersAll')
    const runOut = runs === 'never' ? t('tokens.expiry.never') : runs === 'expired' ? t('tokens.expiry.expired') : t('tokens.expiry.on', { date: day(row.expires_at!, i18n.language) })
    const used = row.last_used_at ? t('tokens.section.lastUsed', { when: ago(new Date(row.last_used_at).getTime(), i18n.language) }) : t('tokens.section.neverUsed')
    return [t(`tokens.level.${row.level}`), row.kind === 'connector' ? t('tokens.admin.connector') : access, folders, runOut, used].join(' · ')
  }

  return (
    <Card id="all-tokens" icon={KeyRound} title={t('tokens.admin.title')} text={t('tokens.admin.text')}>
      <Problem text={problem} />
      {rows && rows.length === 0 && (
        <p className="text-sm text-mist-500" data-testid="all-tokens-none">
          {t('tokens.admin.none')}
        </p>
      )}
      {rows && rows.length > 0 && (
        <ul className="flex flex-col" data-testid="all-tokens">
          {rows.map((row) => (
            <li key={row.id} className="flex items-center gap-3 border-b border-ink-800 py-2.5 last:border-0" data-testid="all-token-row">
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-sm text-mist-100">
                  <span className="text-mist-400">{row.account.name}</span> · {row.name}
                </span>
                <span className="text-xs text-mist-500" data-testid="all-token-meta">
                  {describe(row)}
                </span>
              </span>
              {row.blocked ? (
                <span className="text-xs text-bad-500" data-testid="all-token-blocked">
                  {t('tokens.section.blocked')}
                </span>
              ) : (
                <button type="button" className="text-[13px] text-bad-500 hover:underline" onClick={() => setBlocking(row)} data-testid="all-token-block">
                  {t('tokens.admin.block')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {blocking && (
        <Confirm
          title={t('tokens.admin.blockTitle', { name: blocking.name })}
          text={t('tokens.admin.blockText')}
          confirm={t('tokens.admin.block')}
          danger
          onCancel={() => setBlocking(null)}
          onConfirm={async () => {
            await tokensApi.block(blocking.id)
            setBlocking(null)
            await load()
          }}
        />
      )}
    </Card>
  )
}

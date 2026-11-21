/**
 * Settings, Connections: "API-Token" (NOTES-25). One list for programs and AI tools: a token gets a name, "read only"
 * or "read and write", optionally MCP, all notes or only some folders, and a run-out (90 days chosen), and is shown
 * exactly once with "Copy" (AC-1). The list says right, access, folders, run-out (orange from 7 days before) and last
 * use; older MCP and card keys stand in it with what they still open (AC-2, AC-3). Below it "Verbundene KI-Werkzeuge":
 * programs that signed in with OAuth (AC-4). While the operator has the API switched off, nothing new can be made
 * (AC-5).
 */
import { BookOpen, KeyRound } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Dialog } from '../components/Dialog'
import { Field, Problem } from '../components/Field'
import { foldersApi, type FolderTree } from '../folders/api'
import { copyText } from '../lib/copy'
import { problemText } from '../lib/errors'
import { day } from '../lib/format'
import { ago } from '../lib/time'
import { Card } from '../pages/settings/ui'
import { DEFAULT_DAYS, EXPIRY_CHOICES, expiry, tokensApi, type ApiTokenEntry, type MadeToken, type TokenLevel, type TokenList } from './api'

export function TokensSection() {
  const { t, i18n } = useTranslation()
  const [state, setState] = useState<TokenList | null>(null)
  const [problem, setProblem] = useState('')
  const [making, setMaking] = useState(false)
  const [made, setMade] = useState<MadeToken | null>(null)
  const [copied, setCopied] = useState(false)
  const [revoking, setRevoking] = useState<ApiTokenEntry | null>(null)

  const load = useCallback(() => tokensApi.list().then(setState, (error) => setProblem(problemText(error))), [])
  useEffect(() => {
    void load()
  }, [load])

  const revoke = async (entry: ApiTokenEntry) => {
    setProblem('')
    try {
      await tokensApi.revoke(entry.id)
      if (made?.made.id === entry.id) setMade(null)
      setRevoking(null)
      await load()
    } catch (error) {
      setRevoking(null)
      setProblem(problemText(error))
    }
  }

  const full = state ? state.tokens.length >= state.max_tokens : false
  return (
    <>
      <Card id="tokens" icon={KeyRound} title={t('tokens.section.title')} text={t('tokens.section.text')}>
        {state && !state.allowed && (
          <p className="rounded-[9px] border border-warn-500/30 bg-warn-500/10 px-3 py-2 text-sm text-warn-500" data-testid="tokens-off">
            {t('tokens.section.off')}
          </p>
        )}
        <Problem text={problem} />
        {made && (
          <div className="space-y-2 rounded-[12px] border border-accent-500/40 bg-[var(--color-accent-wash)] p-3" data-testid="tokens-made">
            <p className="text-sm text-mist-100">{t('tokens.section.made', { name: made.made.name })}</p>
            <p className="text-xs text-mist-300">{t('tokens.section.once')}</p>
            <div className="flex gap-2">
              <code className="min-w-0 flex-1 truncate rounded-[8px] border border-ink-700 bg-ink-900 px-2.5 py-2 font-mono text-[12.5px] text-mist-300" data-testid="tokens-secret">
                {made.token}
              </code>
              <button type="button" className="nn-btn nn-btn-accent" onClick={() => void copyText(made.token).then(setCopied)} data-testid="tokens-copy">
                {copied ? t('common.copied') : t('common.copy')}
              </button>
            </div>
          </div>
        )}
        {state && (
          <div className="space-y-1 text-xs text-mist-500">
            <p>
              {t('tokens.section.address')}: <code className="font-mono text-mist-300" data-testid="tokens-address">{state.address}</code>
            </p>
            <p>{t('tokens.section.header')}</p>
            <a href="/api/v1/docs" target="_blank" rel="noopener" className="inline-flex items-center gap-1.5 text-accent-500 hover:underline" data-testid="tokens-docs">
              <BookOpen className="h-3.5 w-3.5" aria-hidden />
              {t('tokens.section.docs')}
            </a>
          </div>
        )}
        {state && state.tokens.length === 0 && (
          <p className="text-sm text-mist-500" data-testid="tokens-none">
            {t('tokens.section.none')}
          </p>
        )}
        {state && state.tokens.length > 0 && (
          <ul className="flex flex-col" data-testid="tokens-list">
            {state.tokens.map((entry) => (
              <TokenRow key={entry.id} entry={entry} lang={i18n.language} onRevoke={() => setRevoking(entry)} />
            ))}
          </ul>
        )}
        {state && (
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="nn-btn nn-btn-ghost"
              disabled={!state.allowed || full}
              onClick={() => {
                setProblem('')
                setMaking(true)
              }}
              data-testid="tokens-new"
            >
              {t('tokens.section.new')}
            </button>
            {full && <span className="text-xs text-mist-500">{t('tokens.section.count', { count: state.tokens.length, max: state.max_tokens })}</span>}
          </div>
        )}
        {making && state && (
          <NewTokenDialog
            mcpAllowed={state.mcp_allowed}
            onClose={() => setMaking(false)}
            onMade={(token) => {
              setMaking(false)
              setCopied(false)
              setMade(token)
              void load()
            }}
          />
        )}
        {revoking && (
          <Dialog title={t('tokens.section.revokeTitle', { name: revoking.name })} onClose={() => setRevoking(null)}>
            <p className="text-sm text-mist-300">{t('tokens.section.revokeText')}</p>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="nn-btn nn-btn-ghost" onClick={() => setRevoking(null)}>
                {t('common.cancel')}
              </button>
              <button type="button" className="nn-btn nn-btn-danger" onClick={() => void revoke(revoking)} data-testid="tokens-revoke-confirm">
                {t('tokens.section.revoke')}
              </button>
            </div>
          </Dialog>
        )}
      </Card>
      {state && <Connectors entries={state.connectors} lang={i18n.language} onRevoke={setRevoking} />}
    </>
  )
}

function lastUse(entry: ApiTokenEntry, lang: string, t: (key: string, values?: Record<string, unknown>) => string): string {
  return entry.last_used_at ? t('tokens.section.lastUsed', { when: ago(new Date(entry.last_used_at).getTime(), lang) }) : t('tokens.section.neverUsed')
}

function TokenRow({ entry, lang, onRevoke }: { entry: ApiTokenEntry; lang: string; onRevoke: () => void }) {
  const { t } = useTranslation()
  const runs = expiry(entry)
  const access = entry.legacy ? t(`tokens.legacy.${entry.legacy}`) : entry.access.map((part) => t(`tokens.access.${part}`)).join(' · ')
  const folders = entry.folders ? t('tokens.list.folders', { count: entry.folders.length }) : t('tokens.list.foldersAll')
  const runOut = runs === 'never' ? t('tokens.expiry.never') : runs === 'expired' ? t('tokens.expiry.expired') : t('tokens.expiry.on', { date: day(entry.expires_at!, lang) })
  return (
    <li className="flex items-center gap-3 border-b border-ink-800 py-2.5 last:border-0" data-testid="token-row">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm text-mist-100" data-testid="token-name">
          {entry.name}
        </span>
        <span className="text-xs text-mist-500" data-testid="token-meta">
          {[t(`tokens.level.${entry.level}`), access, folders].join(' · ')}
        </span>
        <span className="text-xs text-mist-500">
          <span className={runs === 'soon' || runs === 'expired' ? 'text-warn-500' : ''} data-testid="token-expiry" data-state={runs}>
            {runOut}
          </span>
          {' · '}
          {lastUse(entry, lang, t)}
        </span>
        {entry.blocked && (
          <span className="text-xs text-bad-500" data-testid="token-blocked">
            {t('tokens.section.blocked')}
          </span>
        )}
      </span>
      <button type="button" className="text-[13px] text-bad-500 hover:underline" onClick={onRevoke} data-testid="token-revoke">
        {t('tokens.section.revoke')}
      </button>
    </li>
  )
}

/** "Verbundene KI-Werkzeuge": programs that signed in with the member's consent (OAuth, NOTES-20 AC-7). */
function Connectors({ entries, lang, onRevoke }: { entries: ApiTokenEntry[]; lang: string; onRevoke: (entry: ApiTokenEntry) => void }) {
  const { t } = useTranslation()
  return (
    <Card id="connectors" icon={KeyRound} title={t('tokens.connectors.title')} text={t('tokens.connectors.text')}>
      {entries.length === 0 ? (
        <p className="text-sm text-mist-500" data-testid="connectors-none">
          {t('tokens.connectors.none')}
        </p>
      ) : (
        <ul className="flex flex-col" data-testid="connectors-list">
          {entries.map((entry) => (
            <li key={entry.id} className="flex items-center gap-3 border-b border-ink-800 py-2.5 last:border-0" data-testid="connector-row">
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-sm text-mist-100">{entry.name}</span>
                <span className="text-xs text-mist-500">{[t(`tokens.level.${entry.level}`), lastUse(entry, lang, t)].join(' · ')}</span>
                {entry.blocked && <span className="text-xs text-bad-500">{t('tokens.section.blocked')}</span>}
              </span>
              <button type="button" className="text-[13px] text-bad-500 hover:underline" onClick={() => onRevoke(entry)} data-testid="connector-revoke">
                {t('tokens.section.revoke')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

/** The own folders as a flat list with their depth, the inbox first. */
function folderChoices(tree: FolderTree, inboxName: string): { id: string; name: string; depth: number }[] {
  const children = new Map<string | null, FolderTree['folders']>()
  for (const folder of tree.folders) {
    const parent = folder.parent_id && tree.folders.some((other) => other.id === folder.parent_id) ? folder.parent_id : null
    children.set(parent, [...(children.get(parent) ?? []), folder])
  }
  const out = [{ id: tree.inbox.id, name: inboxName, depth: 0 }]
  const walk = (parent: string | null, depth: number) => {
    for (const folder of children.get(parent) ?? []) {
      out.push({ id: folder.id, name: folder.name, depth })
      walk(folder.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
}

function NewTokenDialog({ mcpAllowed, onClose, onMade }: { mcpAllowed: boolean; onClose: () => void; onMade: (token: MadeToken) => void }) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [level, setLevel] = useState<TokenLevel>('read')
  const [mcp, setMcp] = useState(false)
  const [limited, setLimited] = useState(false)
  const [chosen, setChosen] = useState<string[]>([])
  const [tree, setTree] = useState<FolderTree | null>(null)
  const [days, setDays] = useState<number | null>(DEFAULT_DAYS)
  const [problem, setProblem] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (limited && !tree) foldersApi.tree().then(setTree, (error) => setProblem(problemText(error)))
  }, [limited, tree])

  const ready = name.trim() !== '' && (!limited || chosen.length > 0) && !busy
  const make = async () => {
    if (!ready) return
    setBusy(true)
    setProblem('')
    try {
      onMade(await tokensApi.make({ name: name.trim(), level, mcp, folders: limited ? chosen : null, days }))
    } catch (error) {
      setProblem(problemText(error))
      setBusy(false)
    }
  }

  const toggle = (id: string, on: boolean) => setChosen((before) => (on ? [...before, id] : before.filter((other) => other !== id)))

  return (
    <Dialog title={t('tokens.dialog.title')} onClose={onClose} medium>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          void make()
        }}
      >
        <Field label={t('tokens.dialog.name')} value={name} onChange={setName} maxLength={100} hint={t('tokens.dialog.namePlaceholder')} />
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-mist-100">{t('tokens.dialog.right')}</legend>
          {(['read', 'write'] as const).map((choice) => (
            <label key={choice} className="flex cursor-pointer gap-3 rounded-[12px] border border-ink-700 bg-ink-900 px-3 py-2.5">
              <input type="radio" name="token-level" value={choice} checked={level === choice} onChange={() => setLevel(choice)} className="mt-1 accent-[var(--color-accent-500)]" data-testid={`token-level-${choice}`} />
              <span>
                <span className="block text-sm text-mist-100">{t(`tokens.dialog.${choice}`)}</span>
                <span className="block text-xs text-mist-500">{t(`tokens.dialog.${choice}Hint`)}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <label className="flex cursor-pointer items-start gap-3 text-sm">
          <input type="checkbox" checked={mcp} disabled={!mcpAllowed} onChange={(event) => setMcp(event.target.checked)} className="mt-1 accent-[var(--color-accent-500)]" data-testid="token-mcp" />
          <span>
            <span className="block text-mist-100">{t('tokens.dialog.mcp')}</span>
            <span className="block text-xs text-mist-500">{mcpAllowed ? t('tokens.dialog.mcpHint') : t('tokens.dialog.mcpOff')}</span>
          </span>
        </label>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-mist-100">{t('tokens.dialog.folders')}</legend>
          <label className="flex cursor-pointer items-center gap-3 text-sm text-mist-100">
            <input type="radio" name="token-scope" checked={!limited} onChange={() => setLimited(false)} className="accent-[var(--color-accent-500)]" data-testid="token-scope-all" />
            {t('tokens.dialog.foldersAll')}
          </label>
          <label className="flex cursor-pointer items-center gap-3 text-sm text-mist-100">
            <input type="radio" name="token-scope" checked={limited} onChange={() => setLimited(true)} className="accent-[var(--color-accent-500)]" data-testid="token-scope-some" />
            {t('tokens.dialog.foldersSome')}
          </label>
          {limited && tree && (
            <ul className="max-h-48 overflow-y-auto rounded-[12px] border border-ink-700 bg-ink-900 px-3 py-2" data-testid="token-folders">
              {folderChoices(tree, t('folders.inbox.name')).map((folder) => (
                <li key={folder.id} style={{ paddingLeft: folder.depth * 16 }}>
                  <label className="flex cursor-pointer items-center gap-2 py-1 text-sm text-mist-100">
                    <input type="checkbox" checked={chosen.includes(folder.id)} onChange={(event) => toggle(folder.id, event.target.checked)} className="accent-[var(--color-accent-500)]" data-testid="token-folder" data-folder={folder.id} />
                    <span className="truncate">{folder.name}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </fieldset>
        <label className="block text-sm">
          <span className="font-medium text-mist-100">{t('tokens.dialog.expiry')}</span>
          <select className="nn-field mt-1" value={days === null ? 'never' : String(days)} onChange={(event) => setDays(event.target.value === 'never' ? null : Number(event.target.value))} data-testid="token-days">
            {EXPIRY_CHOICES.map((choice) => (
              <option key={String(choice)} value={choice === null ? 'never' : String(choice)}>
                {choice === null ? t('tokens.dialog.never') : t(`tokens.dialog.days_${choice}`)}
              </option>
            ))}
          </select>
        </label>
        <Problem text={problem} />
        <div className="flex justify-end gap-2">
          <button type="button" className="nn-btn nn-btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="nn-btn nn-btn-accent" disabled={!ready} data-testid="token-make">
            {t('tokens.dialog.make')}
          </button>
        </div>
      </form>
    </Dialog>
  )
}

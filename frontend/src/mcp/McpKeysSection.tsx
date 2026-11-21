/**
 * Settings, Connections: "MCP-Schlüssel für KI-Werkzeuge" (NOTES-20, drawing N2-Verbindungen). A key gets a name and
 * "read only" or "read and write", and is shown exactly once with "Copy" (AC-1); the list says name, right and last
 * use (AC-9), and every key and connected program is revoked here (AC-5). While the operator has MCP switched off
 * (AC-8) nothing new can be made.
 */
import { Bot } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Dialog } from '../components/Dialog'
import { Field, Problem } from '../components/Field'
import { copyText } from '../lib/copy'
import { problemText } from '../lib/errors'
import { ago } from '../lib/time'
import { Card } from '../pages/settings/ui'
import { mcpApi, type MadeKey, type McpKey, type McpKeys, type McpLevel } from './api'

export function McpKeysSection() {
  const { t, i18n } = useTranslation()
  const [state, setState] = useState<McpKeys | null>(null)
  const [problem, setProblem] = useState('')
  const [making, setMaking] = useState(false)
  const [made, setMade] = useState<MadeKey | null>(null)
  const [copied, setCopied] = useState(false)
  const [revoking, setRevoking] = useState<McpKey | null>(null)

  const load = useCallback(() => mcpApi.keys().then(setState, (error) => setProblem(problemText(error))), [])
  useEffect(() => {
    void load()
  }, [load])

  const copy = async () => {
    if (made && (await copyText(made.token))) setCopied(true)
  }

  const revoke = async (key: McpKey) => {
    setProblem('')
    try {
      await mcpApi.revoke(key.id)
      if (made?.key.id === key.id) setMade(null)
      setRevoking(null)
      await load()
    } catch (error) {
      setRevoking(null)
      setProblem(problemText(error))
    }
  }

  const meta = (key: McpKey) =>
    [
      t(`mcp.level.${key.level}`),
      key.kind === 'connector' ? t('mcp.section.connector') : null,
      key.last_used_at ? t('mcp.section.lastUsed', { when: ago(new Date(key.last_used_at).getTime(), i18n.language) }) : t('mcp.section.neverUsed'),
    ]
      .filter(Boolean)
      .join(' · ')

  const full = state ? state.keys.length >= state.max_keys : false
  return (
    <Card id="mcp" icon={Bot} title={t('mcp.section.title')} text={t('mcp.section.text')}>
      {state && !state.allowed && (
        <p className="rounded-[9px] border border-warn-500/30 bg-warn-500/10 px-3 py-2 text-sm text-warn-500" data-testid="mcp-off">
          {t('mcp.section.off')}
        </p>
      )}
      <Problem text={problem} />
      {made && (
        <div className="space-y-2 rounded-[12px] border border-accent-500/40 bg-[var(--color-accent-wash)] p-3" data-testid="mcp-made">
          <p className="text-sm text-mist-100">{t('mcp.section.made', { name: made.key.name })}</p>
          <div className="flex gap-2">
            <code className="min-w-0 flex-1 truncate rounded-[8px] border border-ink-700 bg-ink-900 px-2.5 py-2 font-mono text-[12.5px] text-mist-300" data-testid="mcp-token">
              {made.token}
            </code>
            <button type="button" className="nn-btn nn-btn-accent" onClick={() => void copy()} data-testid="mcp-copy">
              {copied ? t('common.copied') : t('common.copy')}
            </button>
          </div>
        </div>
      )}
      {state && (
        <div className="space-y-1 text-xs text-mist-500">
          <p>
            {t('mcp.section.address')}: <code className="font-mono text-mist-300" data-testid="mcp-address">{state.address}</code>
          </p>
          <p>{t('mcp.section.header')}</p>
        </div>
      )}
      {state && state.keys.length === 0 && <p className="text-sm text-mist-500" data-testid="mcp-none">{t('mcp.section.none')}</p>}
      {state && state.keys.length > 0 && (
        <ul className="flex flex-col" data-testid="mcp-keys">
          {state.keys.map((key) => (
            <li key={key.id} className="flex items-center gap-3 border-b border-ink-800 py-2.5 last:border-0" data-testid="mcp-key">
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-sm text-mist-100">{key.name}</span>
                <span className="text-xs text-mist-500" data-testid="mcp-key-meta">
                  {meta(key)}
                </span>
              </span>
              <button type="button" className="text-[13px] text-bad-500 hover:underline" onClick={() => setRevoking(key)} data-testid="mcp-revoke">
                {t('mcp.section.revoke')}
              </button>
            </li>
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
            data-testid="mcp-new"
          >
            {t('mcp.section.new')}
          </button>
          {full && <span className="text-xs text-mist-500">{t('mcp.section.count', { count: state.keys.length, max: state.max_keys })}</span>}
        </div>
      )}
      {making && (
        <NewKeyDialog
          onClose={() => setMaking(false)}
          onMade={(key) => {
            setMaking(false)
            setCopied(false)
            setMade(key)
            void load()
          }}
        />
      )}
      {revoking && (
        <Dialog title={t('mcp.section.revokeTitle', { name: revoking.name })} onClose={() => setRevoking(null)}>
          <p className="text-sm text-mist-300">{t('mcp.section.revokeText')}</p>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" className="nn-btn nn-btn-ghost" onClick={() => setRevoking(null)}>
              {t('common.cancel')}
            </button>
            <button type="button" className="nn-btn nn-btn-danger" onClick={() => void revoke(revoking)} data-testid="mcp-revoke-confirm">
              {t('mcp.section.revoke')}
            </button>
          </div>
        </Dialog>
      )}
    </Card>
  )
}

function NewKeyDialog({ onClose, onMade }: { onClose: () => void; onMade: (key: MadeKey) => void }) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [level, setLevel] = useState<McpLevel>('read')
  const [problem, setProblem] = useState('')
  const [busy, setBusy] = useState(false)

  const make = async () => {
    if (!name.trim() || busy) return
    setBusy(true)
    setProblem('')
    try {
      onMade(await mcpApi.make(name.trim(), level))
    } catch (error) {
      setProblem(problemText(error))
      setBusy(false)
    }
  }

  return (
    <Dialog title={t('mcp.dialog.title')} onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          void make()
        }}
      >
        <Field label={t('mcp.dialog.name')} value={name} onChange={setName} maxLength={100} hint={t('mcp.dialog.namePlaceholder')} />
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-mist-100">{t('mcp.dialog.right')}</legend>
          {(['read', 'write'] as const).map((choice) => (
            <label key={choice} className="flex cursor-pointer gap-3 rounded-[12px] border border-ink-700 bg-ink-900 px-3 py-2.5">
              <input
                type="radio"
                name="mcp-level"
                value={choice}
                checked={level === choice}
                onChange={() => setLevel(choice)}
                className="mt-1 accent-[var(--color-accent-500)]"
                data-testid={`mcp-level-${choice}`}
              />
              <span>
                <span className="block text-sm text-mist-100">{t(`mcp.dialog.${choice}`)}</span>
                <span className="block text-xs text-mist-500">{t(`mcp.dialog.${choice}Hint`)}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <Problem text={problem} />
        <div className="flex justify-end gap-2">
          <button type="button" className="nn-btn nn-btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="nn-btn nn-btn-accent" disabled={!name.trim() || busy} data-testid="mcp-make">
            {t('mcp.dialog.make')}
          </button>
        </div>
      </form>
    </Dialog>
  )
}

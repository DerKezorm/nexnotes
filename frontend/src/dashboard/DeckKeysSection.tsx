/**
 * Settings, Connections: "Schlüssel für nexdeck" (NOTES-21 AC-1). A key gets a name and "show" or "show and tick off",
 * is shown exactly once with "Copy", and the list names right and last use; revoking stops it at once (EC-3).
 */
import { LayoutDashboard } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Dialog } from '../components/Dialog'
import { Field, Problem } from '../components/Field'
import { copyText } from '../lib/copy'
import { problemText } from '../lib/errors'
import { ago } from '../lib/time'
import { Card } from '../pages/settings/ui'
import { deckApi, type DeckKey, type DeckKeys, type DeckLevel, type MadeDeckKey } from './api'

export function DeckKeysSection() {
  const { t, i18n } = useTranslation()
  const [state, setState] = useState<DeckKeys | null>(null)
  const [problem, setProblem] = useState('')
  const [making, setMaking] = useState(false)
  const [made, setMade] = useState<MadeDeckKey | null>(null)
  const [copied, setCopied] = useState(false)
  const [revoking, setRevoking] = useState<DeckKey | null>(null)

  const load = useCallback(() => deckApi.keys().then(setState, (error) => setProblem(problemText(error))), [])
  useEffect(() => {
    void load()
  }, [load])

  const revoke = async (key: DeckKey) => {
    setProblem('')
    try {
      await deckApi.revoke(key.id)
      if (made?.key.id === key.id) setMade(null)
      await load()
    } catch (error) {
      setProblem(problemText(error))
    }
    setRevoking(null)
  }

  const meta = (key: DeckKey) =>
    [t(`deck.level.${key.level}`), key.last_used_at ? t('deck.section.lastUsed', { when: ago(new Date(key.last_used_at).getTime(), i18n.language) }) : t('deck.section.neverUsed')].join(' · ')

  const full = state ? state.keys.length >= state.max_keys : false
  return (
    <Card id="deck" icon={LayoutDashboard} title={t('deck.section.title')} text={t('deck.section.text')}>
      <Problem text={problem} />
      {made && (
        <div className="space-y-2 rounded-[12px] border border-accent-500/40 bg-[var(--color-accent-wash)] p-3" data-testid="deck-made">
          <p className="text-sm text-mist-100">{t('deck.section.made', { name: made.key.name })}</p>
          <div className="flex gap-2">
            <code className="min-w-0 flex-1 truncate rounded-[8px] border border-ink-700 bg-ink-900 px-2.5 py-2 font-mono text-[12.5px] text-mist-300" data-testid="deck-token">
              {made.token}
            </code>
            <button type="button" className="nn-btn nn-btn-accent" onClick={() => void copyText(made.token).then((done) => setCopied(done))} data-testid="deck-copy">
              {copied ? t('common.copied') : t('common.copy')}
            </button>
          </div>
        </div>
      )}
      {state && (
        <p className="text-xs text-mist-500">
          {t('deck.section.address')}: <code className="font-mono text-mist-300" data-testid="deck-address">{state.address}</code>
        </p>
      )}
      {state && state.keys.length === 0 && <p className="text-sm text-mist-500" data-testid="deck-none">{t('deck.section.none')}</p>}
      {state && state.keys.length > 0 && (
        <ul className="flex flex-col" data-testid="deck-keys">
          {state.keys.map((key) => (
            <li key={key.id} className="flex items-center gap-3 border-b border-ink-800 py-2.5 last:border-0" data-testid="deck-key">
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-sm text-mist-100">{key.name}</span>
                <span className="text-xs text-mist-500" data-testid="deck-key-meta">
                  {meta(key)}
                </span>
              </span>
              <button type="button" className="text-[13px] text-bad-500 hover:underline" onClick={() => setRevoking(key)} data-testid="deck-revoke">
                {t('deck.section.revoke')}
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
            disabled={full}
            onClick={() => {
              setProblem('')
              setMaking(true)
            }}
            data-testid="deck-new"
          >
            {t('deck.section.new')}
          </button>
          {full && <span className="text-xs text-mist-500">{t('deck.section.count', { count: state.keys.length, max: state.max_keys })}</span>}
        </div>
      )}
      {making && (
        <NewDeckKey
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
        <Dialog title={t('deck.section.revokeTitle', { name: revoking.name })} onClose={() => setRevoking(null)}>
          <p className="text-sm text-mist-300">{t('deck.section.revokeText')}</p>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" className="nn-btn nn-btn-ghost" onClick={() => setRevoking(null)}>
              {t('common.cancel')}
            </button>
            <button type="button" className="nn-btn nn-btn-danger" onClick={() => void revoke(revoking)} data-testid="deck-revoke-confirm">
              {t('deck.section.revoke')}
            </button>
          </div>
        </Dialog>
      )}
    </Card>
  )
}

function NewDeckKey({ onClose, onMade }: { onClose: () => void; onMade: (key: MadeDeckKey) => void }) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [level, setLevel] = useState<DeckLevel>('write')
  const [problem, setProblem] = useState('')
  const [busy, setBusy] = useState(false)

  const make = async () => {
    if (!name.trim() || busy) return
    setBusy(true)
    setProblem('')
    try {
      onMade(await deckApi.make(name.trim(), level))
    } catch (error) {
      setProblem(problemText(error))
      setBusy(false)
    }
  }

  return (
    <Dialog title={t('deck.dialog.title')} onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          void make()
        }}
      >
        <Field label={t('deck.dialog.name')} value={name} onChange={setName} maxLength={100} hint={t('deck.dialog.namePlaceholder')} />
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-mist-100">{t('deck.dialog.right')}</legend>
          {(['read', 'write'] as const).map((choice) => (
            <label key={choice} className="flex cursor-pointer gap-3 rounded-[12px] border border-ink-700 bg-ink-900 px-3 py-2.5">
              <input
                type="radio"
                name="deck-level"
                value={choice}
                checked={level === choice}
                onChange={() => setLevel(choice)}
                className="mt-1 accent-[var(--color-accent-500)]"
                data-testid={`deck-level-${choice}`}
              />
              <span>
                <span className="block text-sm text-mist-100">{t(`deck.dialog.${choice}`)}</span>
                <span className="block text-xs text-mist-500">{t(`deck.dialog.${choice}Hint`)}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <Problem text={problem} />
        <div className="flex justify-end gap-2">
          <button type="button" className="nn-btn nn-btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="nn-btn nn-btn-accent" disabled={!name.trim() || busy} data-testid="deck-make">
            {t('deck.dialog.make')}
          </button>
        </div>
      </form>
    </Dialog>
  )
}

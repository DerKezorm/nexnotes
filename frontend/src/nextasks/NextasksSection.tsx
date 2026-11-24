/**
 * Settings, Connections: "nextasks" (NOTES-19, drawing N2-Verbindungen; built as nextime's card on 24.11.2026). Not
 * connected, it says how (AC-4); address and key are checked at once (AC-5); the key can be changed, or nextasks
 * disconnected. A nextasks with another API says so here (EC-7).
 *
 * Connected, the card folds to its head (nextasks' logo, "verbunden" and the address, the arrow), folded until opened
 * on this device; just connected it stays open. Open, it shows "Bereiche und Listen": which areas and lists the sending
 * offers, and the standard list it chooses first.
 */
import { ListChecks } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Check } from '../components/Check'
import { Dialog } from '../components/Dialog'
import { Field, Problem } from '../components/Field'
import { problemText } from '../lib/errors'
import { Card } from '../pages/settings/ui'
import { AreaMark } from './AreaMark'
import { nextasksApi, setNextasks, type AreaChoice as AreaRow } from './api'
import { useNextasks } from './hooks'

export function NextasksSection() {
  const { t } = useTranslation()
  const status = useNextasks()
  const [editing, setEditing] = useState(false)
  // Folded from the start once connected; open while there is something to read: just connected here.
  const [fresh, setFresh] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [problem, setProblem] = useState('')

  const disconnect = async () => {
    setProblem('')
    try {
      await nextasksApi.disconnect()
      setNextasks({ connected: false, local_allowed: Boolean(status?.local_allowed) })
    } catch (error) {
      setProblem(problemText(error))
    }
    setLeaving(false)
  }

  return (
    <Card
      id="nextasks"
      icon={ListChecks}
      logo="/apps/nextasks.svg"
      title={t('nextasks.section.title')}
      text={t('nextasks.section.text')}
      foldable={status?.connected && !editing && !fresh ? 'nextasks' : undefined}
      summary={
        status?.connected ? (
          <span className="flex min-w-0 items-center gap-2 text-sm" data-testid="nextasks-summary">
            <span className="h-2 w-2 shrink-0 rounded-full bg-ok-500" aria-hidden />
            <span className="font-medium text-ok-500">{t('nextasks.section.connected')}</span>
            <span className="min-w-0 truncate text-mist-300">{status.host}</span>
          </span>
        ) : undefined
      }
    >
      <Problem text={problem} />
      {status?.connected && !editing && (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm" data-testid="nextasks-connected">
            <span className="flex items-center gap-2 font-medium text-ok-500">
              <span className="h-2 w-2 shrink-0 rounded-full bg-ok-500" aria-hidden />
              {t('nextasks.section.connected')}
            </span>
            <span className="min-w-0 text-mist-300" data-testid="nextasks-address">
              {status.host} · {t('nextasks.section.as', { name: status.name || '?' })}
            </span>
          </div>
          <AreaChoice />
          <div className="flex flex-wrap gap-2">
            <button type="button" className="nn-btn nn-btn-ghost" onClick={() => setEditing(true)} data-testid="nextasks-change">
              {t('nextasks.section.changeKey')}
            </button>
            <button type="button" className="nn-btn nn-btn-ghost" onClick={() => setLeaving(true)} data-testid="nextasks-disconnect">
              {t('nextasks.section.disconnect')}
            </button>
          </div>
        </>
      )}
      {status && (!status.connected || editing) && (
        <ConnectForm
          url={status.url ?? ''}
          localAllowed={status.local_allowed}
          changing={status.connected}
          onCancel={status.connected ? () => setEditing(false) : undefined}
          onDone={() => (setEditing(false), setFresh(true))}
        />
      )}
      {leaving && (
        <Dialog title={t('nextasks.section.disconnectTitle')} onClose={() => setLeaving(false)}>
          <p className="text-sm text-mist-300">{t('nextasks.section.disconnectText')}</p>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" className="nn-btn nn-btn-ghost" onClick={() => setLeaving(false)}>
              {t('common.cancel')}
            </button>
            <button type="button" className="nn-btn nn-btn-danger" onClick={() => void disconnect()} data-testid="nextasks-disconnect-confirm">
              {t('nextasks.section.disconnect')}
            </button>
          </div>
        </Dialog>
      )}
    </Card>
  )
}

function ConnectForm({ url: before, localAllowed, changing, onCancel, onDone }: { url: string; localAllowed: boolean; changing: boolean; onCancel?: () => void; onDone: () => void }) {
  const { t } = useTranslation()
  const [url, setUrl] = useState(before)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')

  const connect = async () => {
    if (busy || !url.trim() || !token.trim()) return
    setBusy(true)
    setProblem('')
    try {
      setNextasks(await nextasksApi.connect(url.trim(), token.trim()))
      setToken('')
      onDone()
    } catch (error) {
      setProblem(problemText(error))
    }
    setBusy(false)
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault()
        void connect()
      }}
      data-testid="nextasks-form"
    >
      {!changing && <p className="text-sm text-mist-300" data-testid="nextasks-how">{t('nextasks.section.how')}</p>}
      <Field label={t('nextasks.section.url')} value={url} onChange={setUrl} type="url" maxLength={500} hint={t('nextasks.section.urlHint')} />
      <Field label={t('nextasks.section.key')} value={token} onChange={setToken} type="password" autoComplete="off" maxLength={500} hint={t('nextasks.section.keyHint')} />
      {!localAllowed && <p className="text-xs text-mist-500" data-testid="nextasks-local">{t('nextasks.section.localOff')}</p>}
      <Problem text={problem} />
      <div className="flex justify-end gap-2">
        {onCancel && (
          <button type="button" className="nn-btn nn-btn-ghost" onClick={onCancel}>
            {t('common.cancel')}
          </button>
        )}
        <button type="submit" className="nn-btn nn-btn-accent" disabled={busy || !url.trim() || !token.trim()} data-testid="nextasks-connect">
          {busy ? t('nextasks.section.checking') : t('nextasks.section.connect')}
        </button>
      </div>
    </form>
  )
}

/** "Bereiche und Listen" (as nextime's, 24.11.2026): a tree, each area with its tick and its lists below, each with
 * nextasks' symbol and colour. An area ticked is the whole area, lists added later too (its lists ticked and locked);
 * otherwise single lists, the area's tick then half. All areas whole from the start; kept per account at the server.
 * Below, the standard list among the chosen ones, chosen first in the sending; one chosen away counts as none. */
function AreaChoice() {
  const { t } = useTranslation()
  const standardId = useId()
  const [areas, setAreas] = useState<AreaRow[] | null>(null)
  const [standard, setStandard] = useState<string | null>(null)
  const [problem, setProblem] = useState('')
  useEffect(() => {
    let live = true
    nextasksApi.areas().then(
      (answer) => {
        if (!live) return
        setAreas(Array.isArray(answer?.areas) ? answer.areas : [])
        setStandard(answer?.default ?? null)
      },
      (error) => live && setProblem(problemText(error)),
    )
    return () => {
      live = false
    }
  }, [])
  if (!areas?.length && !problem) return null

  const chosenLists = (rows: AreaRow[]) =>
    rows.flatMap((area) => area.lists.filter((one) => area.whole || one.chosen).map((one) => ({ ...one, area: area.name })))

  const save = async (next: AreaRow[], nextStandard: string | null) => {
    const before = { areas, standard }
    // A standard list chosen away counts as none at once (the server says the same).
    const kept = nextStandard && chosenLists(next).some((one) => one.id === nextStandard) ? nextStandard : null
    setAreas(next)
    setStandard(kept)
    setProblem('')
    try {
      const whole = next.filter((area) => area.whole).map((area) => area.id)
      const single = next.filter((area) => !area.whole).flatMap((area) => area.lists.filter((one) => one.chosen).map((one) => one.id))
      const answer = await nextasksApi.chooseAreas(whole, single, kept)
      setAreas(answer.areas)
      setStandard(answer.default ?? null)
    } catch (error) {
      setAreas(before.areas)
      setStandard(before.standard)
      setProblem(problemText(error))
    }
  }
  const pickArea = (area: AreaRow, on: boolean) =>
    void save(
      areas!.map((one) => (one.id === area.id ? { ...one, whole: on, lists: one.lists.map((list) => ({ ...list, chosen: on })) } : one)),
      standard,
    )
  const pickList = (area: AreaRow, id: string, on: boolean) =>
    void save(
      areas!.map((one) => (one.id === area.id ? { ...one, lists: one.lists.map((list) => (list.id === id ? { ...list, chosen: on } : list)) } : one)),
      standard,
    )
  const offered = chosenLists(areas ?? [])

  return (
    <div className="space-y-3">
      <fieldset className="space-y-1.5" data-testid="nextasks-areas">
        <legend className="mb-1 text-xs font-semibold tracking-wide text-mist-500 uppercase">{t('nextasks.section.areas')}</legend>
        <p className="text-xs text-mist-500">{t('nextasks.section.areasHint')}</p>
        {(areas ?? []).map((area) => {
          const some = !area.whole && area.lists.some((one) => one.chosen)
          return (
            <div key={area.id} data-testid="nextasks-area-group">
              <label className="flex items-center gap-2.5 text-sm">
                <Check
                  checked={area.whole}
                  ref={(box: HTMLInputElement | null) => {
                    if (box) box.indeterminate = some
                  }}
                  aria-checked={some ? 'mixed' : area.whole}
                  onChange={(on) => pickArea(area, on)}
                  data-testid="nextasks-area"
                />
                <AreaMark area={area} />
                <span className="min-w-0 flex-1 break-words text-mist-100">{area.name}</span>
              </label>
              {area.lists.map((one) => (
                <label key={one.id} className={'mt-1 flex items-center gap-2.5 pl-7 text-sm ' + (area.whole ? 'opacity-60' : '')}>
                  <Check checked={area.whole || one.chosen} disabled={area.whole} onChange={(on) => pickList(area, one.id, on)} data-testid="nextasks-list" />
                  <AreaMark area={one} size={12} />
                  <span className="min-w-0 flex-1 break-words text-mist-300">{one.name}</span>
                </label>
              ))}
            </div>
          )
        })}
      </fieldset>
      {areas && areas.length > 0 && (
        <div className="space-y-1">
          <label htmlFor={standardId} className="block text-sm font-medium text-mist-100">
            {t('nextasks.section.standard')}
          </label>
          <select
            id={standardId}
            className="nn-field"
            value={standard ?? ''}
            disabled={offered.length === 0}
            aria-describedby={`${standardId}-hint`}
            onChange={(event) => void save(areas, event.target.value || null)}
            data-testid="nextasks-standard"
          >
            <option value="">{t('nextasks.section.standardNone')}</option>
            {offered.map((one) => (
              <option key={one.id} value={one.id}>
                {one.area ? `${one.area} › ${one.name}` : one.name}
              </option>
            ))}
          </select>
          <p id={`${standardId}-hint`} className="text-xs text-mist-500">
            {t('nextasks.section.standardHint')}
          </p>
        </div>
      )}
      {problem && <Problem text={problem} />}
    </div>
  )
}

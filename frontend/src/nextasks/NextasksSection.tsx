/**
 * Settings, Connections: "nextasks" (NOTES-19, drawing N2-Verbindungen; built as nextime's card on 24.11.2026). Not
 * connected, it says how (AC-4); address and key are checked at once (AC-5); the key can be changed, or nextasks
 * disconnected. A nextasks with another API says so here (EC-7).
 *
 * A `Collapsible` card of the ui kit (plan "Einstellungen", Verbindungen 3): connected, it folds to its head (nextasks'
 * logo, the badge "verbunden" and the address, the arrow), folded until opened on this device; just connected it stays
 * open. Open, it shows "Bereiche und Listen": which areas and lists the sending offers, and the standard list it
 * chooses first.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Check } from '../components/Check'
import { useDevicePref } from '../lib/devicePref'
import { problemText } from '../lib/errors'
import { Badge, Button, Buttons, Collapsible, ConfirmDialog, Field, Notice, SelectField, useNexuiTexts } from '../vendor/nexui'
import { AreaMark } from './AreaMark'
import { nextasksApi, setNextasks, type AreaChoice as AreaRow } from './api'
import { useNextasks } from './hooks'

export function NextasksSection() {
  const { t } = useTranslation()
  const kit = useNexuiTexts()
  const status = useNextasks()
  const [editing, setEditing] = useState(false)
  // Folded from the start once connected; open while there is something to read: just connected here.
  const [fresh, setFresh] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const [folded, setFolded] = useDevicePref('fold.nextasks', (raw) => raw !== '0')
  const foldable = Boolean(status?.connected) && !editing && !fresh

  const disconnect = async () => {
    setProblem('')
    setBusy(true)
    try {
      await nextasksApi.disconnect()
      setNextasks({ connected: false, local_allowed: Boolean(status?.local_allowed) })
    } catch (error) {
      setProblem(problemText(error))
    }
    setBusy(false)
    setLeaving(false)
  }

  return (
    <Collapsible
      variant="card"
      id="nextasks"
      logo="/apps/nextasks.svg"
      title={t('nextasks.section.title')}
      subtitle={t('nextasks.section.text')}
      open={!foldable || !folded}
      onOpenChange={(open) => setFolded(open ? '0' : null)}
      status={
        status?.connected ? (
          <span className="flex min-w-0 items-center gap-2" data-testid="nextasks-summary">
            <Badge tone="on">{t('nextasks.section.connected')}</Badge>
            <span className="min-w-0 truncate text-sm text-[var(--nexui-text-muted)]">{status.host}</span>
          </span>
        ) : undefined
      }
      testId="nextasks-card"
    >
      {problem && <Notice tone="danger">{problem}</Notice>}
      {status?.connected && !editing && (
        <>
          <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm" data-testid="nextasks-connected">
            <Badge tone="on">{t('nextasks.section.connected')}</Badge>
            <span className="min-w-0 text-[var(--nexui-text-muted)]" data-testid="nextasks-address">
              {status.host} · {t('nextasks.section.as', { name: status.name || '?' })}
            </span>
          </p>
          <AreaChoice />
          <Buttons>
            <Button kind="secondary" icon="KeyRound" onClick={() => setEditing(true)} testId="nextasks-change">
              {t('nextasks.section.changeKey')}
            </Button>
            <Button kind="danger" icon="Unplug" onClick={() => setLeaving(true)} testId="nextasks-disconnect">
              {t('nextasks.section.disconnect')}
            </Button>
          </Buttons>
        </>
      )}
      {status && (!status.connected || editing) && (
        <ConnectForm
          url={status.url ?? ''}
          localAllowed={status.local_allowed}
          changing={status.connected}
          onCancel={status.connected ? () => setEditing(false) : undefined}
          onDone={() => {
            setEditing(false)
            setFresh(true)
          }}
        />
      )}
      {leaving && (
        <ConfirmDialog
          title={t('nextasks.section.disconnectTitle')}
          text={t('nextasks.section.disconnectText')}
          confirm={{ label: t('nextasks.section.disconnect'), kind: 'danger', icon: 'Unplug' }}
          cancel={t('common.cancel')}
          closeLabel={kit.close}
          busy={busy}
          onCancel={() => setLeaving(false)}
          onConfirm={() => void disconnect()}
          testId="nextasks-disconnect-dialog"
        />
      )}
    </Collapsible>
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
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault()
        void connect()
      }}
      data-testid="nextasks-form"
    >
      {!changing && (
        <p className="m-0 text-sm text-[var(--nexui-text-muted)]" data-testid="nextasks-how">
          {t('nextasks.section.how')}
        </p>
      )}
      <Field label={t('nextasks.section.url')} value={url} onChange={(event) => setUrl(event.target.value)} type="url" maxLength={500} hints={[t('nextasks.section.urlHint')]} data-testid="nextasks-url" />
      <Field
        label={t('nextasks.section.key')}
        value={token}
        onChange={(event) => setToken(event.target.value)}
        type="password"
        autoComplete="off"
        maxLength={500}
        hints={[t('nextasks.section.keyHint')]}
        data-testid="nextasks-key"
      />
      {!localAllowed && (
        <p className="m-0 text-xs text-[var(--nexui-text-muted)]" data-testid="nextasks-local">
          {t('nextasks.section.localOff')}
        </p>
      )}
      {problem && <Notice tone="danger">{problem}</Notice>}
      <Buttons end>
        {onCancel && (
          <Button kind="secondary" icon="X" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
        )}
        <Button kind="primary" icon="Plug" type="submit" busy={busy} disabled={!url.trim() || !token.trim()} testId="nextasks-connect">
          {busy ? t('nextasks.section.checking') : t('nextasks.section.connect')}
        </Button>
      </Buttons>
    </form>
  )
}

/** "Bereiche und Listen" (as nextime's, 24.11.2026): a tree, each area with its tick and its lists below, each with
 * nextasks' symbol and colour. An area ticked is the whole area, lists added later too (its lists ticked and locked);
 * otherwise single lists, the area's tick then half. All areas whole from the start; kept per account at the server.
 * Below, the standard list among the chosen ones, chosen first in the sending; one chosen away counts as none. */
function AreaChoice() {
  const { t } = useTranslation()
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
    <div className="flex flex-col gap-3">
      <fieldset className="space-y-1.5" data-testid="nextasks-areas">
        <legend className="mb-1 text-sm font-medium text-[var(--nexui-text)]">{t('nextasks.section.areas')}</legend>
        <p className="m-0 text-xs text-[var(--nexui-text-muted)]">{t('nextasks.section.areasHint')}</p>
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
        <SelectField
          label={t('nextasks.section.standard')}
          value={standard ?? ''}
          disabled={offered.length === 0}
          hints={[t('nextasks.section.standardHint')]}
          onChange={(event) => void save(areas, event.target.value || null)}
          options={[{ value: '', label: t('nextasks.section.standardNone') }, ...offered.map((one) => ({ value: one.id, label: one.area ? `${one.area} › ${one.name}` : one.name }))]}
          data-testid="nextasks-standard"
        />
      )}
      {problem && <Notice tone="danger">{problem}</Notice>}
    </div>
  )
}

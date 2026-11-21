/**
 * Making or changing a smart folder (drawing "N7-Intelligent", NOTES-7 AC-1 to AC-3, AC-6, EC-6): the name, "alle" or
 * "mindestens eine", the conditions one per row, and beside them the preview of what fits right now with its count.
 * `/smart/new` makes one (from the search it comes with the search's conditions, AC-5), `/smart/<id>/edit` changes one.
 * A name that is taken is said by the server and shown here.
 */
import { X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate, useParams } from 'react-router-dom'

import { Problem } from '../components/Field'
import { FOLDER_COLORS } from '../folders/palette'
import { flatten, useFolders } from '../folders/store'
import { problemText } from '../lib/errors'
import { pageTitle } from '../lib/title'
import { listDate } from '../notes/listDate'
import type { ListItem } from '../notes/list/api'
import { useTags } from '../tags/store'
import { smartApi, type Condition, type Match, type Preview, type SmartFolder } from './api'
import { ATTACHMENT_TYPES, blank, complete, KINDS, kindOf, PERIODS, smartName, tagOf, type KindChoice } from './conditions'
import { refreshSmartFolders } from './store'

/** How long the preview waits after a change before it asks (AC-3: "sofort", without a request per keystroke). */
export const PREVIEW_WAIT_MS = 250

/** What `/smart/new` may be handed (the search's "Als intelligenten Ordner sichern"). */
export type NewSmartFolder = { conditions?: Condition[]; name?: string }

const SELECT = 'nn-field h-[38px] w-auto min-w-0 py-0 pr-8 text-[13.5px]'

function Select<T extends string>({ value, options, onChange, label, testId }: { value: T; options: { value: T; text: string }[]; onChange: (value: T) => void; label: string; testId?: string }) {
  return (
    <select className={SELECT} value={value} aria-label={label} onChange={(event) => onChange(event.target.value as T)} data-testid={testId}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.text}
        </option>
      ))}
    </select>
  )
}

function ConditionRow({ condition, onChange, onRemove, index }: { condition: Condition; onChange: (next: Condition) => void; onRemove: () => void; index: number }) {
  const { t } = useTranslation()
  const tree = useFolders()
  const { tags } = useTags()
  const [typedTag, setTypedTag] = useState(condition.kind === 'tag' ? (condition.label ? `#${condition.label}` : '') : '')
  const listId = `smart-tags-${index}`
  const kind = kindOf(condition)
  const kinds = KINDS.map((value) => ({ value, text: t(`smart.kind.${value}`) }))
  const change = (next: KindChoice) => {
    if (next !== kind) {
      setTypedTag('')
      onChange(blank(next))
    }
  }

  let parts: ReactNode = null
  switch (condition.kind) {
    case 'text':
      parts = (
        <input
          className="nn-field h-[38px] min-w-[160px] flex-1 text-[13.5px]"
          value={condition.value}
          maxLength={500}
          placeholder={t('smart.textPlaceholder')}
          aria-label={t('smart.kind.text')}
          onChange={(event) => onChange({ ...condition, value: event.target.value })}
          data-testid="smart-text"
        />
      )
      break
    case 'tag':
      parts = (
        <>
          <Select
            value={condition.op}
            label={t('smart.op')}
            options={[
              { value: 'has', text: t('smart.tagOp.has') },
              { value: 'not', text: t('smart.tagOp.not') },
            ]}
            onChange={(op) => onChange({ ...condition, op })}
            testId="smart-tag-op"
          />
          <input
            className="nn-field h-[38px] w-40 text-[13.5px] text-accent-400"
            list={listId}
            value={typedTag}
            placeholder={t('search.filter.tagPlaceholder')}
            aria-label={t('smart.kind.tag')}
            onChange={(event) => {
              setTypedTag(event.target.value)
              onChange({ ...condition, ...tagOf(event.target.value) })
            }}
            data-testid="smart-tag"
          />
          <datalist id={listId}>
            {tags.slice(0, 200).map((tag) => (
              <option key={tag.key} value={`#${tag.label}`} />
            ))}
          </datalist>
        </>
      )
      break
    case 'folder': {
      const rows = flatten(tree, null)
      parts = (
        <>
          <Select
            value={condition.op}
            label={t('smart.op')}
            options={[
              { value: 'tree', text: t('smart.folderOp.tree') },
              { value: 'in', text: t('smart.folderOp.in') },
            ]}
            onChange={(op) => onChange({ ...condition, op })}
            testId="smart-folder-op"
          />
          <select
            className={SELECT}
            value={condition.id}
            aria-label={t('smart.kind.folder')}
            onChange={(event) => onChange({ ...condition, id: event.target.value, name: tree.byId.get(event.target.value)?.name ?? '' })}
            data-testid="smart-folder"
          >
            <option value="">{t('smart.chooseFolder')}</option>
            {tree.inbox && <option value={tree.inbox.id}>{t('notes.inbox')}</option>}
            {condition.id && condition.id !== tree.inbox?.id && !tree.byId.has(condition.id) && <option value={condition.id}>{t('smart.broken.gone', { name: condition.name || '?' })}</option>}
            {rows.map(({ folder, depth }) => (
              <option key={folder.id} value={folder.id}>
                {' '.repeat(depth * 2) + folder.name}
              </option>
            ))}
          </select>
        </>
      )
      break
    }
    case 'date':
      parts = (
        <>
          <Select
            value={condition.period}
            label={t('smart.periodLabel')}
            options={PERIODS.map((value) => ({ value, text: t(`smart.period.${value}`) }))}
            onChange={(period) => onChange(period === 'custom' ? { ...condition, period } : { kind: 'date', field: condition.field, period })}
            testId="smart-period"
          />
          {condition.period === 'custom' && (
            <>
              <input
                type="date"
                className="nn-field h-[38px] w-auto text-[13.5px]"
                value={condition.from ?? ''}
                aria-label={t('search.filter.from')}
                onChange={(event) => onChange({ ...condition, from: event.target.value || undefined })}
                data-testid="smart-from"
              />
              <input
                type="date"
                className="nn-field h-[38px] w-auto text-[13.5px]"
                value={condition.to ?? ''}
                aria-label={t('search.filter.to')}
                onChange={(event) => onChange({ ...condition, to: event.target.value || undefined })}
                data-testid="smart-to"
              />
            </>
          )}
        </>
      )
      break
    case 'tasks':
      parts = <span className="flex h-[38px] items-center px-1 text-[13.5px] text-mist-200">{t('smart.says.tasksShort')}</span>
      break
    case 'attachment':
      parts = (
        <Select
          value={condition.type}
          label={t('smart.kind.attachment')}
          options={ATTACHMENT_TYPES.map((value) => ({ value, text: t(`smart.attachment.${value}`) }))}
          onChange={(type) => onChange({ ...condition, type })}
          testId="smart-attachment"
        />
      )
      break
    case 'shared':
      parts = (
        <Select
          value={condition.op}
          label={t('smart.kind.shared')}
          options={[
            { value: 'with_me', text: t('smart.shared.with_me') },
            { value: 'by_me', text: t('smart.shared.by_me') },
          ]}
          onChange={(op) => onChange({ ...condition, op })}
          testId="smart-shared"
        />
      )
      break
    case 'color':
      parts = (
        <Select
          value={condition.color}
          label={t('smart.kind.color')}
          options={FOLDER_COLORS.map((color) => ({ value: color.key, text: t(`folders.colors.${color.key}`) }))}
          onChange={(color) => onChange({ ...condition, color })}
          testId="smart-color"
        />
      )
      break
    case 'pinned':
      break
  }

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="smart-condition-row">
      <Select value={kind} label={t('smart.kindLabel')} options={kinds} onChange={change} testId="smart-kind" />
      {parts}
      <button
        type="button"
        onClick={onRemove}
        aria-label={t('smart.removeCondition')}
        className="flex h-[34px] w-[34px] items-center justify-center rounded-lg text-mist-500 hover:bg-ink-800 hover:text-mist-100"
        data-testid="smart-remove"
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
    </div>
  )
}

function PreviewItem({ item, lang }: { item: ListItem; lang: string }) {
  const { t } = useTranslation()
  const tree = useFolders()
  const where = item.owner
    ? t('tags.from', { name: item.owner.name })
    : tree.inbox?.id === item.folder_id
      ? t('notes.inbox')
      : (tree.byId.get(item.folder_id)?.name ?? '')
  const meta = [where, item.tasks ? t('smart.tasksDone', { done: item.tasks.done, total: item.tasks.total }) : '', item.updated_at ? listDate(item.updated_at, lang) : '']
    .filter(Boolean)
    .join(' · ')
  return (
    <li className="flex flex-col gap-[3px] rounded-[12px] border border-ink-700 bg-ink-850 px-3.5 py-3" data-testid="smart-preview-item">
      <span className="truncate text-[14.5px] font-semibold">{item.title || t('notes.untitled')}</span>
      <span className="truncate text-[12.5px] text-mist-500">{meta}</span>
    </li>
  )
}

export function SmartEditor() {
  const { t, i18n } = useTranslation()
  const { id } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const handed = (location.state as NewSmartFolder | null) ?? null
  const [loaded, setLoaded] = useState<SmartFolder | null>(null)
  const [name, setName] = useState(handed?.name ?? '')
  const [match, setMatch] = useState<Match>('all')
  // Each row keeps its own key: taking one out leaves the others as they are (what is typed into them stays).
  const keys = useRef(0)
  const keyed = (list: Condition[]) => list.map((condition) => ({ key: ++keys.current, condition }))
  const [rows, setRows] = useState<{ key: number; condition: Condition }[]>(() => keyed(handed?.conditions?.length ? handed.conditions : [blank('tag')]))
  const conditions = useMemo(() => rows.map((row) => row.condition), [rows])
  const [preview, setPreview] = useState<Preview | null>(null)
  const [previewProblem, setPreviewProblem] = useState('')
  const [problem, setProblem] = useState('')
  const [busy, setBusy] = useState(false)
  const asked = useRef(0)

  useEffect(() => {
    document.title = pageTitle(id ? t('smart.editTitle') : t('smart.newTitle'))
  }, [id, t])

  // Changing one: its name, "all"/"any" and conditions as they are on the server.
  useEffect(() => {
    if (!id) return
    smartApi
      .read(id)
      .then((folder) => {
        setLoaded(folder)
        setName(smartName(folder, t))
        setMatch(folder.match)
        setRows(keyed(folder.conditions.length ? folder.conditions : [blank('tag')]))
      })
      .catch((error) => setProblem(problemText(error)))
    // Only when another folder is opened, not when the language changes under the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const ready = useMemo(() => conditions.filter(complete), [conditions])
  const readyKey = JSON.stringify([match, ready])

  // The preview follows every change (AC-3); a late answer to an older state is dropped.
  useEffect(() => {
    const mine = ++asked.current
    if (ready.length === 0) {
      setPreview(null)
      setPreviewProblem('')
      return
    }
    const timer = setTimeout(() => {
      smartApi
        .preview(match, ready)
        .then((found) => {
          if (mine !== asked.current) return
          setPreview(found)
          setPreviewProblem('')
        })
        .catch((error) => {
          if (mine === asked.current) setPreviewProblem(problemText(error))
        })
    }, PREVIEW_WAIT_MS)
    return () => clearTimeout(timer)
    // readyKey stands for `match` and `ready`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readyKey])

  const setOne = (key: number, next: Condition) => setRows((all) => all.map((row) => (row.key === key ? { key, condition: next } : row)))
  const takeOut = (key: number) => setRows((all) => all.filter((row) => row.key !== key))

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setProblem('')
    // A folder that came with the account keeps its name in every language while it is not given another one.
    const keepsPreset = loaded?.preset && !loaded.name && name.trim() === smartName(loaded, t)
    const body = { name: keepsPreset ? '' : name, match, conditions: ready }
    try {
      const saved = loaded ? await smartApi.update(loaded.id, body) : await smartApi.create(body)
      await refreshSmartFolders()
      navigate(`/smart/${encodeURIComponent(saved.id)}`)
    } catch (error) {
      setProblem(problemText(error))
      setBusy(false)
    }
  }

  const cancel = () => (id ? navigate(`/smart/${encodeURIComponent(id)}`) : navigate(-1))

  return (
    <div className="flex min-h-full flex-wrap items-start gap-6 px-4 py-5 md:px-8 md:py-6" data-testid="smart-editor">
      <form onSubmit={(event) => void save(event)} className="flex max-w-[640px] min-w-0 flex-[1_1_520px] flex-col gap-3.5 rounded-[16px] border border-ink-700 bg-ink-850 p-5">
        <h1 className="m-0 text-xl font-bold">{id ? t('smart.editTitle') : t('smart.newTitle')}</h1>
        <label className="flex flex-col gap-1.5 text-[13px] font-semibold">
          {t('smart.name')}
          <input className="nn-field h-10 text-sm font-normal" value={name} maxLength={60} onChange={(event) => setName(event.target.value)} autoFocus data-testid="smart-name" />
        </label>
        <div className="flex flex-wrap items-center gap-2 text-[13.5px]">
          {t('smart.matchBefore')}
          <span role="radiogroup" aria-label={t('smart.matchLabel')} className="flex rounded-[9px] border border-ink-700 bg-ink-900 p-[3px] text-[12.5px]">
            {(['all', 'any'] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={match === value}
                onClick={() => setMatch(value)}
                className={'rounded-md px-2.5 py-[5px] ' + (match === value ? 'bg-accent-wash font-semibold text-accent-400' : 'text-mist-500 hover:text-mist-100')}
                data-testid={`smart-match-${value}`}
              >
                {t(`smart.match.${value}`)}
              </button>
            ))}
          </span>
          {t('smart.matchAfter')}
        </div>
        {rows.map((row) => (
          <ConditionRow key={row.key} index={row.key} condition={row.condition} onChange={(next) => setOne(row.key, next)} onRemove={() => takeOut(row.key)} />
        ))}
        <button type="button" className="self-start px-0.5 py-1.5 text-[13.5px] text-accent-400 hover:underline" onClick={() => setRows((all) => [...all, ...keyed([blank('tag')])])} data-testid="smart-add">
          + {t('smart.addCondition')}
        </button>
        <Problem text={problem} />
        <span className="flex justify-end gap-2 border-t border-ink-700 pt-3">
          <button type="button" className="nn-btn nn-btn-ghost" onClick={cancel}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="nn-btn nn-btn-accent" disabled={busy || !name.trim() || ready.length === 0} data-testid="smart-save">
            {t('smart.save')}
          </button>
        </span>
      </form>
      <section aria-label={t('smart.previewLabel')} className="flex max-w-[460px] min-w-0 flex-[1_1_320px] flex-col gap-2" data-testid="smart-preview">
        <span className="text-[13px] font-semibold text-mist-500" aria-live="polite" data-testid="smart-preview-count">
          {ready.length === 0 ? t('smart.previewHint') : preview ? t('smart.previewCount', { count: preview.total }) : ''}
        </span>
        {previewProblem && <p className="text-sm text-bad-500">{previewProblem}</p>}
        <ul className="flex flex-col gap-2">
          {(ready.length ? (preview?.items ?? []) : []).map((item) => (
            <PreviewItem key={item.id} item={item} lang={i18n.language} />
          ))}
        </ul>
        {preview && preview.total > preview.items.length && (
          <span className="text-[12.5px] text-mist-500">{t('smart.previewMore', { count: preview.total - preview.items.length })}</span>
        )}
      </section>
    </div>
  )
}

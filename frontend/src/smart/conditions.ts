/**
 * The conditions of a smart folder in the page (NOTES-7 AC-1): which kinds there are, a new one of each kind, whether
 * one is complete enough to ask the server, how one reads as a sentence (the empty state, EC-2), and what a search
 * becomes when it is saved as a smart folder (AC-5, NOTES-9 AC-6).
 */
import type { TFunction } from 'i18next'

import type { SearchConditions } from '../search'
import { cleanName, keyOf } from '../tags/rules'
import type { AttachmentType, Condition, Period, Preset, SmartFolder } from './api'

/** The kinds in the order the "+ Bedingung" list offers them. `updated` and `created` are the two sides of `date`. */
export const KINDS = ['tag', 'folder', 'updated', 'created', 'tasks', 'attachment', 'shared', 'pinned', 'color', 'text'] as const
export type KindChoice = (typeof KINDS)[number]

export const PERIODS: Period[] = ['today', 'week', 'month', 'year', 'custom']
export const ATTACHMENT_TYPES: AttachmentType[] = ['any', 'image', 'pdf', 'scan', 'recording', 'sketch', 'video', 'file']

/** The kind a condition is chosen as in the list. */
export function kindOf(condition: Condition): KindChoice {
  return condition.kind === 'date' ? condition.field : condition.kind
}

/** A new condition of a kind, as complete as it can be without the member's choice. */
export function blank(kind: KindChoice): Condition {
  switch (kind) {
    case 'tag':
      return { kind: 'tag', op: 'has', key: '', label: '' }
    case 'folder':
      return { kind: 'folder', op: 'tree', id: '' }
    case 'updated':
    case 'created':
      return { kind: 'date', field: kind, period: 'week' }
    case 'tasks':
      return { kind: 'tasks', op: 'open' }
    case 'attachment':
      return { kind: 'attachment', type: 'any' }
    case 'shared':
      return { kind: 'shared', op: 'with_me' }
    case 'pinned':
      return { kind: 'pinned' }
    case 'color':
      return { kind: 'color', color: 'honey' }
    case 'text':
      return { kind: 'text', value: '' }
  }
}

/** Whether a condition says enough to be asked: a tag, a folder, a word, a day of a period of one's own. */
export function complete(condition: Condition): boolean {
  switch (condition.kind) {
    case 'text':
      return condition.value.trim() !== ''
    case 'tag':
      return condition.key !== ''
    case 'folder':
      return condition.id !== ''
    case 'date':
      return condition.period !== 'custom' || Boolean(condition.from || condition.to)
    default:
      return true
  }
}

/** A tag as typed (with or without `#`) for a condition; empty key when it is no tag. */
export function tagOf(typed: string): { key: string; label: string } {
  const label = cleanName(typed)
  return { key: label ? keyOf(label) : '', label: label || typed.replace(/^#/, '') }
}

const SEARCH_PERIODS: Record<string, Period> = { week: 'week', month: 'month', year: 'year', custom: 'custom' }

/** What a search becomes as a smart folder: exactly its conditions (AC-5). The words go as "Text enthält" (the
 * server reads them as the search does), the folder with its subfolders, the tag as "has", the period as "changed". */
export function fromSearch(search: SearchConditions): Condition[] {
  const out: Condition[] = []
  if (search.q.trim()) out.push({ kind: 'text', value: search.q.trim() })
  if (search.folderId) out.push({ kind: 'folder', op: 'tree', id: search.folderId })
  if (search.tag) {
    const tag = tagOf(search.tag)
    if (tag.key) out.push({ kind: 'tag', op: 'has', ...tag })
  }
  const period = SEARCH_PERIODS[search.period]
  if (period === 'custom') {
    if (search.from || search.to)
      out.push({ kind: 'date', field: 'updated', period, ...(search.from ? { from: search.from } : {}), ...(search.to ? { to: search.to } : {}) })
  } else if (period) out.push({ kind: 'date', field: 'updated', period })
  return out
}

/** A name to start with for a smart folder saved from a search: its words, else its tag. */
export function nameFromSearch(search: SearchConditions): string {
  if (search.q.trim()) return search.q.trim().slice(0, 60)
  if (search.tag) return `#${search.tag.replace(/^#/, '')}`.slice(0, 60)
  return ''
}

/** Whether a smart folder asks for attachments: then its attachments can be looked at as the gallery. */
export function asksAttachments(folder: Pick<SmartFolder, 'conditions'>): boolean {
  return folder.conditions.some((condition) => condition.kind === 'attachment')
}

/** Whether a smart folder asks for what others shared with the member: then it leads to "Mit mir geteilt". */
export function asksSharedWithMe(folder: Pick<SmartFolder, 'conditions'>): boolean {
  return folder.conditions.some((condition) => condition.kind === 'shared' && condition.op === 'with_me')
}

/** The name a smart folder shows: its own, or the one of a preset in the page's language. */
export function smartName(folder: Pick<SmartFolder, 'name' | 'preset'>, t: TFunction): string {
  if (folder.name) return folder.name
  return folder.preset ? t(`smart.preset.${folder.preset as Exclude<Preset, ''>}`) : ''
}

function day(value: string | undefined, lang: string): string {
  if (!value) return ''
  const [year, month, date] = value.split('-').map(Number)
  return new Date(year, month - 1, date).toLocaleDateString(lang, { day: 'numeric', month: 'short', year: 'numeric' })
}

/** One condition as a sentence ("Schlagwort hat #rezept"), for the empty state and the hint of what points nowhere.
 * `folderName` gives the name of a folder by its id (the tree of the sidebar). */
export function describe(condition: Condition, t: TFunction, lang: string, folderName: (id: string) => string | null): string {
  switch (condition.kind) {
    case 'text':
      return t('smart.says.text', { value: condition.value })
    case 'tag':
      return t(condition.op === 'has' ? 'smart.says.tagHas' : 'smart.says.tagNot', { tag: `#${condition.label || condition.key}` })
    case 'folder': {
      const name = folderName(condition.id) ?? condition.name ?? ''
      return t(condition.op === 'tree' ? 'smart.says.folderTree' : 'smart.says.folderIn', { name })
    }
    case 'date': {
      const what = t(condition.field === 'created' ? 'smart.kind.created' : 'smart.kind.updated')
      if (condition.period !== 'custom') return `${what} ${t(`smart.period.${condition.period}`)}`
      if (condition.from && condition.to) return `${what} ${t('smart.says.between', { from: day(condition.from, lang), to: day(condition.to, lang) })}`
      if (condition.from) return `${what} ${t('smart.says.since', { from: day(condition.from, lang) })}`
      return `${what} ${t('smart.says.until', { to: day(condition.to, lang) })}`
    }
    case 'tasks':
      return t('smart.says.tasks')
    case 'attachment':
      return t('smart.says.attachment', { type: t(`smart.attachment.${condition.type}`) })
    case 'shared':
      return t(condition.op === 'by_me' ? 'smart.shared.by_me' : 'smart.shared.with_me')
    case 'pinned':
      return t('smart.kind.pinned')
    case 'color':
      return t('smart.says.color', { color: t(`folders.colors.${condition.color}`) })
  }
}

/**
 * Server › Storage and backups (NOTES-1 AC-4, AC-5, AC-11): the cards "Speicher" and "Sicherung" of the shared module
 * sicherung (`vendor/nexsicherung`, bauplaene/sicherung 1.0.0) over its routes (`/api/server/storage`). nexnotes hands
 * it its sentence of what a backup holds, the counts of an entry and what a restore changes in the notes (numbers for
 * all, titles only of the asking account's own, NOTES-2 AC-7).
 */
import { useTranslation } from 'react-i18next'

import { tabId } from '../../api/client'
import { useAuth } from '../../state/auth'
import { StorageArea as SharedStorageArea } from '../../vendor/nexsicherung/StorageArea'
import { makeSicherungApi, type Brief, type Entry } from '../../vendor/nexsicherung/sicherung'
import { languageOf } from '../../vendor/nexui'

/** nexnotes' own client for the module: every request names its tab (changes are refused without it). */
const api = makeSicherungApi((path, init) => {
  const headers = new Headers(init.headers)
  headers.set('Accept', 'application/json')
  headers.set('X-Nexnotes-Client', tabId())
  return fetch(path, { ...init, headers })
}, '/api/server/storage')

const number = (value: unknown) => (typeof value === 'number' ? value : 0)
const titles = (value: unknown) => (Array.isArray(value) ? value.map(String) : [])

export function StorageArea() {
  const { t, i18n } = useTranslation()
  const { me } = useAuth()
  const counts = (facts: Record<string, unknown>) =>
    t('server.backupContent', { notes: t('server.countNotes', { count: number(facts.notes) }), files: t('server.countFiles', { count: number(facts.files) }) })
  const facts = (entry: Entry) => (entry.facts && ('notes' in entry.facts || 'files' in entry.facts) ? counts(entry.facts) : null)
  const details = (brief: Brief) => {
    const found = brief.details ?? {}
    const kinds = (['add', 'change', 'remove'] as const).filter((kind) => titles(found[`notes_${kind}_titles`]).length > 0)
    return (
      <div className="flex flex-col gap-1" data-testid="restore-notes">
        <p className="m-0">
          {t('server.restoreChanges', {
            add: t('server.countFiles', { count: number(found.would_add) }),
            change: t('server.countFiles', { count: number(found.would_change) }),
            remove: t('server.countFiles', { count: number(found.would_remove) }),
          })}
        </p>
        <p className="m-0">{t('server.restoreNotes', { add: number(found.notes_add), change: number(found.notes_change), remove: number(found.notes_remove) })}</p>
        {kinds.map((kind) => (
          <p key={kind} className="m-0 text-xs">
            {t(`server.restoreTitles.${kind}`, { titles: titles(found[`notes_${kind}_titles`]).map((title) => title || t('server.untitled')).join(', ') })}
          </p>
        ))}
        {kinds.length > 0 && <p className="m-0 text-xs">{t('server.restoreTitles.own')}</p>}
      </div>
    )
  }
  return (
    <SharedStorageArea
      app="nexnotes"
      things={t('settings.things')}
      holds={t('server.backupHolds')}
      api={api}
      password={me?.sign_in === 'password'}
      facts={facts}
      details={details}
      language={languageOf(i18n.language)}
    />
  )
}

/**
 * Server › General (plan "Einstellungen", "Allgemein"), the cards in their order: "Grenzen" (the largest attachment with
 * its own save, how long the history and the trash keep things), "Funktionen für alle Konten" (the switches),
 * "Schnittstellen" (the module schluessel's, placed by `SettingsAreas`), "Sprachen" (the module sprachen's). And Server › Text recognition, nexnotes' own
 * area: the languages it reads as a segment of several. Built only from the ui kit.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { tabId } from '../../api/client'
import { own, TEMPLATE_TEXTS } from '../../i18n'
import { LanguagesCard as SharedLanguagesCard } from '../../vendor/nexsprachen/LanguagesCard'
import type { Fetcher } from '../../vendor/nexsprachen/sprachen'
import { Button, Card, CheckboxRow, Field, Segment, SelectField } from '../../vendor/nexui'
import { Outcome } from './Outcome'
import type { Server } from './ServerCards'

/** The limits (NOTES-1 AC-6): the largest attachment, how long the history and the trash keep things. */
// eslint-disable-next-line react-refresh/only-export-components
export const HISTORY_DAYS = [30, 90, 180, 365, 730] as const
// eslint-disable-next-line react-refresh/only-export-components
export const TRASH_DAYS = [7, 30, 90, 180, 365] as const
const GB = 1024 ** 3

export function LimitsCard({ server }: { server: Server }) {
  const { t } = useTranslation()
  const [size, setSize] = useState<string | null>(null)
  const [newLimit, setNewLimit] = useState<string | null>(null)
  const s = server.settings
  if (!s) return null
  const shownLimit = s.new_account_storage_limit ? String(Math.round((s.new_account_storage_limit / GB) * 10) / 10) : ''
  const saveNewLimit = () => {
    const typed = (newLimit ?? shownLimit).replace(',', '.').trim()
    const gigabytes = Number(typed)
    if (typed && (!Number.isFinite(gigabytes) || gigabytes <= 0)) return
    void server.save({ new_account_storage_limit: typed ? Math.round(gigabytes * GB) : null }, t('settings.saved')).then(() => setNewLimit(null))
  }
  const daysLabel = (days: number) => (days % 365 === 0 ? t('server.years', { count: days / 365 }) : t('server.days', { count: days }))
  const saveSize = () => {
    const value = Math.max(1, Math.min(100_000, Number(size ?? s.upload_max_mb) || 100))
    void server.save({ upload_max_mb: value }, t('settings.saved')).then(() => setSize(null))
  }
  return (
    <Card id="limits" icon="Gauge" title={t('server.limits')} subtitle={t('server.limitsHint')}>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          saveSize()
        }}
      >
        <Field
          label={t('server.uploadMax')}
          type="number"
          min={1}
          max={100000}
          value={size ?? String(s.upload_max_mb)}
          onChange={(event) => setSize(event.target.value)}
          hints={[t('server.uploadMaxHint')]}
          data-testid="limits-upload-max"
          action={
            <Button kind="secondary" icon="Check" type="submit" busy={server.busy} testId="limits-upload-save">
              {t('common.save')}
            </Button>
          }
        />
      </form>
      {/* Bauplan E44: the limit every new account starts with; the limit of one account is set under Accounts. */}
      <form
        onSubmit={(event) => {
          event.preventDefault()
          saveNewLimit()
        }}
      >
        <Field
          label={t('server.newAccountStorage')}
          type="number"
          min={0}
          step="any"
          value={newLimit ?? shownLimit}
          onChange={(event) => setNewLimit(event.target.value)}
          hints={[t('server.newAccountStorageHint')]}
          data-testid="limits-new-account-storage"
          action={
            <Button kind="secondary" icon="Check" type="submit" busy={server.busy} testId="limits-new-account-storage-save">
              {t('common.save')}
            </Button>
          }
        />
      </form>
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField
          label={t('server.history')}
          value={String(s.history_days)}
          onChange={(event) => void server.save({ history_days: Number(event.target.value) }, t('settings.saved'))}
          options={HISTORY_DAYS.map((days) => ({ value: String(days), label: daysLabel(days) }))}
          data-testid="limits-history"
        />
        <SelectField
          label={t('server.trash')}
          value={String(s.trash_days)}
          onChange={(event) => void server.save({ trash_days: Number(event.target.value) }, t('settings.saved'))}
          options={TRASH_DAYS.map((days) => ({ value: String(days), label: daysLabel(days) }))}
          data-testid="limits-trash"
        />
      </div>
      <Outcome problem={server.problem} done={server.done} />
    </Card>
  )
}

/**
 * The switches of the features for everybody (NOTES-1 AC-8). "MCP-Zugang" and "Programmschnittstelle (API) für
 * Mitglieder" are the card "Schnittstellen" of the module schluessel (`tokens/KeysCards.tsx`), right after this one.
 */
export function FeaturesCard({ server }: { server: Server }) {
  const { t } = useTranslation()
  const s = server.settings
  if (!s) return null
  return (
    <Card id="features" icon="SlidersHorizontal" title={t('server.features')} subtitle={t('server.featuresHint')}>
      <CheckboxRow label={t('server.linkPreviews')} hint={t('server.linkPreviewsHint')} checked={s.link_previews} onChange={(link_previews) => void server.save({ link_previews })} testId="feature-link-previews" />
      <CheckboxRow label={t('server.shareLinks')} hint={t('server.shareLinksHint')} checked={s.share_links} onChange={(share_links) => void server.save({ share_links })} testId="feature-share-links" />
      <CheckboxRow
        label={t('server.localNetwork')}
        hint={t('server.localNetworkHint')}
        checked={Boolean(s.connections_local_network)}
        onChange={(connections_local_network) => void server.save({ connections_local_network })}
        testId="feature-local-network"
      />
      <Outcome problem={server.problem} />
    </Card>
  )
}

/** nexnotes' way to the server for the card "Sprachen": every request names its tab (changes are refused without). */
const sprachenFetch: Fetcher = (path, init) => {
  const headers = new Headers(init.headers)
  headers.set('X-Nexnotes-Client', tabId())
  return fetch(path, { credentials: 'same-origin', ...init, headers })
}

/** The operator's own languages (NOTES-22 AC-5): the card of the module sprachen (E51), the template made on the page
 * from the English texts; after a change the menus ask the server again. */
export function LanguagesCard() {
  return <SharedLanguagesCard app="nexnotes" base="/api/locales" template={TEMPLATE_TEXTS} onChange={own.forget} fetcher={sprachenFetch} />
}

/** The languages text recognition reads (NOTES-1 AC-8, NOTES-11): German and English from the start. */
// eslint-disable-next-line react-refresh/only-export-components
export const OCR_LANGUAGES = ['de', 'en', 'fr', 'es', 'it', 'nl', 'pt', 'pl', 'tr'] as const

export function OcrCard({ server }: { server: Server }) {
  const { t } = useTranslation()
  const s = server.settings
  if (!s) return null
  type Code = (typeof OCR_LANGUAGES)[number]
  return (
    <Card id="ocr" icon="ScanText" title={t('server.ocr')} subtitle={t('server.ocrHint')}>
      <Segment<Code>
        multiple
        min={1}
        label={t('server.ocrLanguagesLabel')}
        value={s.ocr_languages as Code[]}
        onChange={(next) => void server.save({ ocr_languages: OCR_LANGUAGES.filter((item) => next.includes(item)) })}
        options={OCR_LANGUAGES.map((code) => ({ value: code, label: t(`server.ocrLanguages.${code}`), testId: `ocr-${code}` }))}
        testId="ocr-languages"
      />
      <Outcome problem={server.problem} />
    </Card>
  )
}

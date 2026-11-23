/**
 * The operator's server settings (drawing N1-Server): limits, storage and backups, the switches of the features, text
 * recognition, sign-in (`SignInCards.tsx`), the invitation mail and the operator's own languages; and the log. Everything
 * here is the server's; it applies to everyone.
 */
import { Download, Globe, Mail, RotateCcw, ScanText, ShieldCheck, SlidersHorizontal, Gauge, HardDrive, Trash2, Upload } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  api,
  ApiError,
  backupsApi,
  passwordHeader,
  settingsApi,
  type AddressQuestion,
  type BackupBrief,
  type BackupEntry,
  type ExtraLocale,
  type ServerSettings,
  type SettingsChange,
} from '../../api/client'
import { byName, forgetAddedLanguages, templateFile } from '../../i18n'
import { bytes, dayTime } from '../../lib/format'
import { moment } from '../../lib/time'
import { useAuth } from '../../state/auth'
import { ASKED, Button, Card, Confirm, Feedback, Input, saveAsFile, Select, Toggle, useAction } from './ui'

type Server = ReturnType<typeof useServerSettings>

// eslint-disable-next-line react-refresh/only-export-components
export function useServerSettings() {
  const [settings, setSettings] = useState<ServerSettings | null>(null)
  const action = useAction()
  useEffect(() => {
    settingsApi.read().then(setSettings, () => undefined)
  }, [])
  /** The switch moves at once; the server's answer confirms it, a refusal puts it back. */
  const save = async (change: SettingsChange, done?: string) => {
    const before = settings
    if (settings) setSettings({ ...settings, ...change } as ServerSettings)
    const ok = await action.run(async () => setSettings(await settingsApi.save(change)), done)
    if (!ok) setSettings(before)
    return ok
  }
  /**
   * Saves the public address. authentik, set up by the button, knows the old one: the server then answers 409
   * `public_url_change` and saves nothing. That comes back as the question to put to the operator.
   */
  const saveAddress = async (public_url: string, confirm: boolean, done?: string): Promise<AddressQuestion | null> => {
    let question: AddressQuestion | null = null
    await action.run(async () => {
      try {
        setSettings(await settingsApi.save({ public_url, confirm_address: confirm }))
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== 'public_url_change') throw error
        question = { count: Number(error.values.count ?? 0), hand: Number(error.values.hand ?? 0), address: String(error.values.address ?? '') }
        return ASKED
      }
    }, done)
    return question
  }
  const reload = useCallback(() => settingsApi.read().then(setSettings, () => undefined), [])
  return { settings, save, saveAddress, reload, ...action }
}

/** Requests come with proxy headers, but no proxy is named: the sign-in brake sees one sender for everybody. */
export function ProxyHint({ server }: { server: Server }) {
  const { t } = useTranslation()
  if (!server.settings?.proxy_unknown) return null
  return (
    <p role="status" className="rounded-[12px] border border-warn-500/30 bg-warn-500/10 px-4 py-3 text-sm text-mist-100" data-testid="proxy-hint">
      {t('server.proxyUnknown')}
    </p>
  )
}

/** The limits (NOTES-1 AC-6): the largest attachment, how long the history and the trash keep things. */
// eslint-disable-next-line react-refresh/only-export-components
export const HISTORY_DAYS = [30, 90, 180, 365, 730] as const
// eslint-disable-next-line react-refresh/only-export-components
export const TRASH_DAYS = [7, 30, 90, 180, 365] as const

export function LimitsCard({ server }: { server: Server }) {
  const { t } = useTranslation()
  const [size, setSize] = useState<string | null>(null)
  const s = server.settings
  if (!s) return null
  const daysLabel = (days: number) => (days % 365 === 0 ? t('server.years', { count: days / 365 }) : t('server.days', { count: days }))
  return (
    <Card id="limits" icon={Gauge} title={t('server.limits')}>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          const value = Math.max(1, Math.min(100_000, Number(size ?? s.upload_max_mb) || 100))
          void server.save({ upload_max_mb: value }, t('settings.saved')).then(() => setSize(null))
        }}
      >
        <Input label={t('server.uploadMax')} type="number" min={1} max={100000} value={size ?? String(s.upload_max_mb)} onChange={setSize} hint={t('server.uploadMaxHint')} className="w-48" />
        <Button type="submit" busy={server.busy}>
          {t('common.save')}
        </Button>
      </form>
      <div className="grid gap-3 sm:grid-cols-2">
        <Select
          label={t('server.history')}
          value={String(s.history_days)}
          onChange={(value) => void server.save({ history_days: Number(value) }, t('settings.saved'))}
          options={HISTORY_DAYS.map((days) => ({ value: String(days), label: daysLabel(days) }))}
        />
        <Select
          label={t('server.trash')}
          value={String(s.trash_days)}
          onChange={(value) => void server.save({ trash_days: Number(value) }, t('settings.saved'))}
          options={TRASH_DAYS.map((days) => ({ value: String(days), label: daysLabel(days) }))}
        />
      </div>
      <p className="text-xs text-mist-500">{t('server.limitsHint')}</p>
      <Feedback problem={server.problem} done={server.done} />
    </Card>
  )
}

/** The switches of the features for everybody (NOTES-1 AC-8). */
export function FeaturesCard({ server }: { server: Server }) {
  const { t } = useTranslation()
  const s = server.settings
  if (!s) return null
  return (
    <Card id="features" icon={SlidersHorizontal} title={t('server.features')}>
      <Toggle label={t('server.linkPreviews')} hint={t('server.linkPreviewsHint')} checked={s.link_previews} onChange={(link_previews) => void server.save({ link_previews })} />
      <Toggle label={t('server.shareLinks')} hint={t('server.shareLinksHint')} checked={s.share_links} onChange={(share_links) => void server.save({ share_links })} />
      <Toggle label={t('server.mcp')} hint={t('server.mcpHint')} checked={s.mcp_enabled} onChange={(mcp_enabled) => void server.save({ mcp_enabled })} />
      <Toggle label={t('server.api')} hint={t('server.apiHint')} checked={s.api_enabled !== false} onChange={(api_enabled) => void server.save({ api_enabled })} />
      <Toggle
        label={t('server.localNetwork')}
        hint={t('server.localNetworkHint')}
        checked={Boolean(s.connections_local_network)}
        onChange={(connections_local_network) => void server.save({ connections_local_network })}
      />
    </Card>
  )
}

/** The languages text recognition reads (NOTES-1 AC-8, NOTES-11): German and English from the start. */
// eslint-disable-next-line react-refresh/only-export-components
export const OCR_LANGUAGES = ['de', 'en', 'fr', 'es', 'it', 'nl', 'pt', 'pl', 'tr'] as const

export function OcrCard({ server }: { server: Server }) {
  const { t } = useTranslation()
  const s = server.settings
  if (!s) return null
  const chosen = new Set(s.ocr_languages)
  return (
    <Card id="ocr" icon={ScanText} title={t('server.ocr')} text={t('server.ocrHint')}>
      <div className="flex flex-wrap gap-2" role="group" aria-label={t('server.ocr')}>
        {OCR_LANGUAGES.map((code) => {
          const on = chosen.has(code)
          return (
            <button
              key={code}
              type="button"
              aria-pressed={on}
              disabled={on && chosen.size === 1}
              onClick={() => {
                const next = on ? s.ocr_languages.filter((item) => item !== code) : [...s.ocr_languages, code]
                void server.save({ ocr_languages: OCR_LANGUAGES.filter((item) => next.includes(item)) })
              }}
              className={'rounded-[9px] border px-3 py-1.5 text-sm ' + (on ? 'nn-chosen border-accent-700/50' : 'border-ink-700 text-mist-400 not-disabled:hover:text-mist-100')}
            >
              {t(`server.ocrLanguages.${code}`)}
            </button>
          )
        })}
      </div>
    </Card>
  )
}

/** The parts of what nexnotes takes in its data folder, in the order the page names them. */
const STORAGE_PARTS = ['database', 'attachments', 'backups', 'exports', 'other'] as const

/** Storage and backups (NOTES-1 AC-4, AC-5, AC-11): the data folder, the schedule, the list, check before restore. */
export function BackupsCard({ server }: { server: Server }) {
  const { t, i18n } = useTranslation()
  const { me } = useAuth()
  const [list, setList] = useState<BackupEntry[]>([])
  const [brief, setBrief] = useState<BackupBrief | null>(null)
  const [asking, setAsking] = useState<{ kind: 'restore' | 'download' | 'delete' | 'upload'; name: string; file?: File; brief?: BackupBrief } | null>(null)
  const picker = useRef<HTMLInputElement>(null)
  const [keep, setKeep] = useState<string | null>(null)
  const [restarting, setRestarting] = useState(false)
  const [uploaded, setUploaded] = useState(false)
  const action = useAction()
  const load = useCallback(() => {
    backupsApi.list().then(setList, () => undefined)
  }, [])
  useEffect(load, [load])
  // A backup made, deleted or brought in changes what nexnotes takes: the list and the numbers above it.
  const refresh = () => {
    load()
    void server.reload()
  }
  const s = server.settings
  if (!s) return null
  const lang = i18n.language
  const forBackup = (entry: BackupEntry, verb: string) => t('server.forBackup', { name: moment(entry.created, lang), action: verb })
  // What nexnotes takes, not the whole disk (NOTES-1 AC-11): the bar shows its share of the disk next to what else
  // lies there, so a nearly full disk shows even when nexnotes is small on it.
  const own = s.nexnotes_used ?? 0
  const share = (part: number) => (s.data_total ? Math.min(100, (part / s.data_total) * 100) : 0)
  const ownShare = share(own)
  const otherShare = Math.min(100 - ownShare, share(Math.max(0, s.data_used - own)))
  const nearlyFull = s.data_total > 0 && s.data_used / s.data_total > 0.9
  const parts = STORAGE_PARTS.filter((part) => part === 'database' || (s.nexnotes_parts?.[part] ?? 0) > 0)
  const last = list[0]
  const changes = (b: BackupBrief) =>
    t('server.restoreChanges', { add: t('server.countFiles', { count: b.would_add }), change: t('server.countFiles', { count: b.would_change }), remove: t('server.countFiles', { count: b.would_remove }) })
  // What a restore does to the notes (NOTES-1 AC-5): the numbers, and the first titles of the operator's own.
  const noteChanges = (b: BackupBrief) => {
    const kinds = (['add', 'change', 'remove'] as const).filter((kind) => b[`notes_${kind}_titles`].length > 0)
    return (
      <div className="space-y-1 text-sm" data-testid="restore-notes">
        <p>{t('server.restoreNotes', { add: b.notes_add, change: b.notes_change, remove: b.notes_remove })}</p>
        {kinds.map((kind) => (
          <p key={kind} className="text-xs text-mist-400">
            {t(`server.restoreTitles.${kind}`, { titles: b[`notes_${kind}_titles`].map((title) => title || t('server.untitled')).join(', ') })}
          </p>
        ))}
        {kinds.length > 0 && <p className="text-xs text-mist-500">{t('server.restoreTitles.own')}</p>}
      </div>
    )
  }
  return (
    <Card id="backups" icon={HardDrive} title={t('server.storage')} text={t('server.backupHolds')}>
      <div className="space-y-1.5" data-testid="data-folder">
        <div className="flex flex-wrap justify-between gap-2 text-sm">
          <span className="text-mist-300">{t('server.nexnotesUses')}</span>
          <span className="text-mist-100" data-testid="nexnotes-used">{bytes(own, lang)}</span>
        </div>
        <p className="text-xs text-mist-500" data-testid="nexnotes-parts">
          {parts.map((part) => t('server.part', { name: t(`server.parts.${part}`), size: bytes(s.nexnotes_parts?.[part] ?? 0, lang) })).join(' · ')}
        </p>
        <div className="flex h-2 overflow-hidden rounded-full bg-ink-700" role="img" aria-label={t('server.diskBar', { own: bytes(own, lang), used: bytes(s.data_used, lang), total: bytes(s.data_total, lang) })}>
          <div className="h-full" style={{ width: `${ownShare}%`, minWidth: own > 0 ? 3 : 0, background: 'var(--color-progress)' }} />
          <div className="h-full" style={{ width: `${otherShare}%`, background: nearlyFull ? 'var(--color-warn-500)' : 'var(--color-mist-500)', opacity: nearlyFull ? 1 : 0.35 }} />
        </div>
        <p className={'text-xs ' + (nearlyFull ? 'text-warn-500' : 'text-mist-500')} data-testid="disk-free">
          {t('server.diskFree', { free: bytes(s.data_free, lang), total: bytes(s.data_total, lang) })}
        </p>
        {s.data_on_share && <p className="rounded-[9px] border border-warn-500/30 bg-warn-500/10 px-3 py-2 text-xs text-warn-500">{t('setup.share')}</p>}
      </div>
      <p className="text-sm text-mist-300">{last ? t('server.lastBackup', { time: dayTime(last.created, lang) }) : t('server.noBackups')}</p>
      <div className="flex flex-wrap items-end gap-2">
        <Select
          label={t('server.schedule')}
          value={s.backup_schedule}
          onChange={(backup_schedule) => void server.save({ backup_schedule })}
          options={[
            { value: 'off', label: t('server.off') },
            { value: 'daily', label: t('server.daily') },
            { value: 'weekly', label: t('server.weekly') },
          ]}
          className="w-44"
        />
        <form
          className="flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void server.save({ backup_keep: Math.max(1, Math.min(365, Number(keep ?? s.backup_keep) || 7)) }, t('settings.saved'))
          }}
        >
          <Input label={t('server.keep')} type="number" min={1} max={365} value={keep ?? String(s.backup_keep)} onChange={setKeep} className="w-28" />
          <Button type="submit" busy={server.busy}>
            {t('common.save')}
          </Button>
        </form>
        <span className="ml-auto flex flex-wrap gap-2">
          <input
            ref={picker}
            type="file"
            accept=".zip,application/zip"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) setAsking({ kind: 'upload', name: file.name, file })
            }}
          />
          <Button onClick={() => picker.current?.click()}>
            <Upload className="h-4 w-4" strokeWidth={1.8} />
            {t('server.uploadBackup')}
          </Button>
          <Button
            accent
            busy={action.busy}
            onClick={() =>
              void action.run(async () => {
                await backupsApi.make()
                refresh()
              }, t('server.backupMade'))
            }
          >
            {t('server.backupNow')}
          </Button>
        </span>
      </div>
      <Feedback problem={server.problem} done={server.done} />
      {/* Without backups the line above says so once; an empty list would say it a second time. */}
      {list.length > 0 && (
        <ul className="divide-y divide-ink-700 rounded-[12px] border border-ink-700 text-sm" data-testid="backup-list">
          {list.map((entry) => (
            <li key={entry.name} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="text-mist-100">{dayTime(entry.created, lang)}</div>
                <div className="text-xs text-mist-500">
                  {entry.uploaded ? t('server.uploaded') : t(`server.kinds.${entry.kind}`)} · {t('server.backupContent', { notes: t('server.countNotes', { count: entry.notes }), files: t('server.countFiles', { count: entry.files }) })} · {bytes(entry.size, lang)} · {entry.version}
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <Button small label={forBackup(entry, t('server.check'))} onClick={() => void action.run(async () => setBrief(await backupsApi.check(entry.name)))}>
                  <ShieldCheck className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden />
                  {t('server.check')}
                </Button>
                <Button small label={forBackup(entry, t('server.download'))} onClick={() => setAsking({ kind: 'download', name: entry.name })}>
                  <Download className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden />
                  {t('server.download')}
                </Button>
                <Button
                  small
                  label={forBackup(entry, t('server.restore'))}
                  onClick={() =>
                    void action.run(async () => {
                      // First the trial run: what comes, what changes, what goes (NOTES-1 AC-5); then the question.
                      const checked = await backupsApi.check(entry.name)
                      setBrief(checked)
                      if (checked.usable) setAsking({ kind: 'restore', name: entry.name, brief: checked })
                    })
                  }
                >
                  <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden />
                  {t('server.restore')}
                </Button>
                <Button small danger label={forBackup(entry, t('server.deleteBackup'))} onClick={() => setAsking({ kind: 'delete', name: entry.name })}>
                  <Trash2 className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden />
                  {t('server.deleteBackup')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {brief && (
        <div data-testid="backup-brief" className={'rounded-[12px] border px-4 py-3 text-sm ' + (brief.usable ? 'border-ok-500/40 bg-ok-500/10 text-mist-200' : 'border-bad-500/40 bg-bad-500/10 text-bad-500')}>
          {brief.usable ? (
            <>
              <p>{`${t('server.checkOk', { notes: t('server.countNotes', { count: brief.notes }), files: t('server.countFiles', { count: brief.files }) })} ${changes(brief)}`}</p>
              <div className="mt-1">{noteChanges(brief)}</div>
            </>
          ) : (
            t('server.checkBad')
          )}
        </div>
      )}
      {uploaded && <p className="rounded-[12px] border border-ok-500/40 bg-ok-500/10 px-4 py-3 text-sm text-mist-200">{t('server.uploadedHint')}</p>}
      {restarting && <p className="rounded-[12px] border border-warn-500/40 bg-warn-500/10 px-4 py-3 text-sm text-warn-500">{t('server.restarting')}</p>}
      <Feedback problem={action.problem} done={action.done} />
      {asking && (
        <Confirm
          title={t(`server.confirm.backup_${asking.kind}.title`)}
          text={asking.kind === 'restore' && asking.brief ? `${changes(asking.brief)} ${t('server.confirm.backup_restore.text')}` : t(`server.confirm.backup_${asking.kind}.text`)}
          details={asking.kind === 'restore' && asking.brief ? noteChanges(asking.brief) : undefined}
          confirm={t(`server.confirm.backup_${asking.kind}.button`)}
          danger={asking.kind !== 'download'}
          password={me?.sign_in === 'password'}
          onCancel={() => setAsking(null)}
          onConfirm={async (password) => {
            if (asking.kind === 'download') saveAsFile(asking.name, await backupsApi.download(asking.name, password))
            if (asking.kind === 'delete') {
              await backupsApi.remove(asking.name, password)
              refresh()
            }
            if (asking.kind === 'upload' && asking.file) {
              await api('/api/backups/upload', { method: 'POST', raw: asking.file, headers: { 'X-Nexnotes-Password': passwordHeader(password) } })
              refresh()
              setUploaded(true)
            }
            if (asking.kind === 'restore') {
              await backupsApi.restore(asking.name, password)
              setRestarting(true)
              window.setTimeout(() => window.location.reload(), 8000)
            }
            setAsking(null)
          }}
        />
      )}
    </Card>
  )
}

export function MailCard({ server }: { server: Server }) {
  const { t, i18n } = useTranslation()
  const [draft, setDraft] = useState<SettingsChange>({})
  const [to, setTo] = useState('')
  const test = useAction()
  const s = server.settings
  if (!s) return null
  const value = { ...s, ...draft }
  return (
    <Card id="mail" icon={Mail} title={t('server.mail')} text={t('server.mailHint')}>
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault()
          void server.save(draft, t('settings.saved')).then(() => setDraft({}))
        }}
      >
        <Input label={t('server.smtpHost')} value={value.smtp_host ?? ''} onChange={(smtp_host) => setDraft({ ...draft, smtp_host })} placeholder="smtp.example.com" />
        <Input label={t('server.smtpPort')} type="number" value={String(value.smtp_port)} onChange={(port) => setDraft({ ...draft, smtp_port: Number(port) })} />
        <Select
          label={t('server.smtpSecurity')}
          value={value.smtp_security ?? 'starttls'}
          onChange={(smtp_security) => setDraft({ ...draft, smtp_security })}
          options={[
            { value: 'starttls', label: 'STARTTLS' },
            { value: 'tls', label: 'TLS' },
            { value: 'none', label: t('server.none') },
          ]}
        />
        <Input label={t('server.smtpUser')} value={value.smtp_user ?? ''} onChange={(smtp_user) => setDraft({ ...draft, smtp_user })} />
        <Input label={t('auth.password')} type="password" autoComplete="new-password" value={draft.smtp_password ?? ''} onChange={(smtp_password) => setDraft({ ...draft, smtp_password })} placeholder={s.smtp_password_set ? t('server.secretKept') : ''} />
        <Input label={t('server.smtpFrom')} value={value.smtp_from ?? ''} onChange={(smtp_from) => setDraft({ ...draft, smtp_from })} placeholder="notes@example.com" />
        <div className="sm:col-span-2">
          <Button type="submit" accent busy={server.busy}>
            {t('common.save')}
          </Button>
        </div>
      </form>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          void test.run(() => settingsApi.mailTest(to, i18n.language), t('server.mailSent'))
        }}
      >
        <Input label={t('server.mailTest')} value={to} onChange={setTo} placeholder="you@example.com" className="min-w-60 flex-1" />
        <Button type="submit" busy={test.busy} disabled={!to.trim()}>
          {t('server.send')}
        </Button>
      </form>
      <Feedback problem={test.problem ?? server.problem} done={test.done ?? server.done} />
    </Card>
  )
}

/** The operator's own languages (NOTES-22 AC-5): files in the data folder, or uploaded here. */
export function LanguagesCard() {
  const { t } = useTranslation()
  const [list, setList] = useState<ExtraLocale[]>([])
  const [code, setCode] = useState('')
  const file = useRef<HTMLInputElement>(null)
  const action = useAction()
  const load = useCallback(() => {
    api<ExtraLocale[]>('/api/locales').then((rows) => setList(rows.sort(byName)), () => undefined)
  }, [])
  useEffect(load, [load])
  const chip = 'flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs'
  return (
    <Card id="languages" icon={Globe} title={t('server.languages')} text={t('server.languagesHint')}>
      <div className="flex flex-wrap gap-2">
        <span className={chip + ' border-ink-700 text-mist-300'}>Deutsch · {t('server.builtIn')}</span>
        <span className={chip + ' border-ink-700 text-mist-300'}>English · {t('server.builtIn')}</span>
        {list.map((entry) => (
          <span key={entry.code} className={chip + ' border-accent-700/40 text-mist-200'}>
            {entry.name} ({entry.code}) · {t('server.texts', { count: entry.keys })}
            <button
              type="button"
              aria-label={t('server.remove')}
              className="text-mist-500 hover:text-bad-500"
              onClick={() =>
                void action.run(async () => {
                  await api(`/api/locales/${entry.code}`, { method: 'DELETE' })
                  forgetAddedLanguages()
                  load()
                })
              }
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </span>
        ))}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <Button onClick={() => saveAsFile('nexnotes-language-template.json', templateFile())}>
          <Download className="h-4 w-4" strokeWidth={1.8} />
          {t('server.template')}
        </Button>
        <Input label={t('server.languageCode')} value={code} onChange={(value) => setCode(value.trim())} placeholder="nl" className="w-28" />
        <Button disabled={!code} busy={action.busy} onClick={() => file.current?.click()}>
          <Upload className="h-4 w-4" strokeWidth={1.8} />
          {t('server.upload')}
        </Button>
        <input
          ref={file}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(e) => {
            const chosen = e.target.files?.[0]
            e.target.value = ''
            if (!chosen) return
            void action.run(async () => {
              await api(`/api/locales/${encodeURIComponent(code)}`, { method: 'PUT', raw: chosen })
              forgetAddedLanguages()
              load()
            }, t('server.languageAdded'))
          }}
        />
      </div>
      <Feedback problem={action.problem} done={action.done} />
    </Card>
  )
}


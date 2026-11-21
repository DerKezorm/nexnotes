/**
 * The attachments dock onto the frame (`extensions.ts`, NOTES-10): "Anhänge" among the places at the top of the
 * sidebar (after the inbox, drawing "Seitenleiste"), the gallery `/attachments`, and the orange bar "Speicher voll"
 * over every page once the account's storage is full (AC-11). Imported in `main.tsx` after the folders.
 */
import { Paperclip } from 'lucide-react'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, NavLink } from 'react-router-dom'

import { FEATURE_ROUTES, SHELL_BANNERS, SIDEBAR_SECTIONS } from '../extensions'
import { bytes } from '../lib/format'
import { GalleryPage } from './GalleryPage'
import { loadLimits, useLimits } from './info'

export function AttachmentsEntry() {
  const { t } = useTranslation()
  return (
    <NavLink
      to="/attachments"
      data-testid="sidebar-attachments"
      className={({ isActive }) => 'mt-1 flex h-[34px] items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] transition-colors ' + (isActive ? 'nn-chosen font-semibold' : 'text-mist-100 hover:bg-ink-800')}
    >
      <Paperclip className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
      {t('attachments.gallery.title')}
    </NavLink>
  )
}

/** How often the bar asks whether the storage is still full (or became full on another device). */
export const STORAGE_EVERY_MS = 60_000

/** "Dein Speicher ist voll" with taken and allowed, and the way to the largest attachments (AC-11). */
export function StorageBar() {
  const { t, i18n } = useTranslation()
  const limits = useLimits()
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') void loadLimits(true)
    }, STORAGE_EVERY_MS)
    return () => clearInterval(timer)
  }, [])
  if (!limits?.full || limits.limit === null) return null
  return (
    <div role="status" data-testid="storage-full" className="flex flex-wrap items-center gap-2.5 px-5 py-3 text-[13.5px] font-medium text-warn-500" style={{ background: 'rgb(251 146 60 / 0.14)' }}>
      <span>{t('attachments.storage.full', { used: bytes(limits.used, i18n.language), limit: bytes(limits.limit, i18n.language) })}</span>
      <Link to="/attachments?sort=largest" className="ml-auto font-semibold text-warn-500 underline-offset-2 hover:underline" data-testid="storage-large">
        {t('attachments.storage.large')}
      </Link>
    </div>
  )
}

const inbox = SIDEBAR_SECTIONS.findIndex((section) => section.key === 'inbox')
SIDEBAR_SECTIONS.splice(inbox >= 0 ? inbox + 1 : SIDEBAR_SECTIONS.length, 0, { key: 'attachments', render: () => <AttachmentsEntry /> })
FEATURE_ROUTES.push({ path: 'attachments', element: <GalleryPage /> })
SHELL_BANNERS.push({ key: 'storage', render: () => <StorageBar /> })

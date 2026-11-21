/**
 * The attachments dock onto the frame (`extensions.ts`, NOTES-10): the gallery `/attachments`, and the orange bar
 * "Speicher voll" over every page once the account's storage is full (AC-11), which leads to it. "Anhänge" is no fixed
 * entry of the sidebar any more but a smart folder every account gets (NOTES-7, preset `attachments`), opening as the
 * gallery of its notes' attachments. Imported in `main.tsx` after the folders.
 */
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

import { FEATURE_ROUTES, SHELL_BANNERS } from '../extensions'
import { bytes } from '../lib/format'
import { GalleryPage } from './GalleryPage'
import { loadLimits, useLimits } from './info'

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

FEATURE_ROUTES.push({ path: 'attachments', element: <GalleryPage /> })
SHELL_BANNERS.push({ key: 'storage', render: () => <StorageBar /> })

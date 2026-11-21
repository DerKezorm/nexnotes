/**
 * Settings (NOTES-2 AC-9) in areas: "My account" (Profile, Security, Appearance, Connections) for every account, "Server"
 * (General, Sign-in, Mail, Storage and backups, Text recognition, Accounts, Log) for the operator, "About nexnotes" for
 * everyone at the end. Each area has its
 * own address (`/settings/<slug>`, `areas.ts`), `/settings` is the profile. An area someone may not open, or an
 * address of the tabs before, leads on with the address replaced, so the navigation always marks where one is.
 */
import { useTranslation } from 'react-i18next'
import { Navigate, useLocation, useParams } from 'react-router-dom'

import { useTitle } from '../lib/title'
import { useAuth } from '../state/auth'
import { areaPath, findArea, resolveArea } from './settings/areas'
import { AreaContent } from './settings/SettingsAreas'
import { SettingsJump, SettingsNav } from './settings/SettingsNav'

export function SettingsPage() {
  const { t } = useTranslation()
  const { me } = useAuth()
  const { tab: asked } = useParams()
  const { search } = useLocation()
  const where = resolveArea(asked, me?.role, search)
  const area = 'area' in where ? findArea(where.area) : undefined
  const title = area ? t(`settings.areas.${area.key}.title`) : ''
  useTitle(area ? `${title} · ${t('settings.title')}` : t('settings.title'))
  if (!me) return null
  if ('redirect' in where) return <Navigate to={where.redirect} replace />
  if (!area) return null
  return (
    <div className="@container mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
      <div className="flex flex-col gap-5 @min-[700px]:flex-row @min-[700px]:items-start @min-[700px]:gap-8">
        <SettingsNav me={me} current={area.slug} />
        <SettingsJump me={me} current={area.slug} />
        <div className="min-w-0 flex-1 space-y-5" data-testid={`settings-area-${area.slug}`}>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-mist-100">{title}</h1>
            <p className="mt-1 text-sm text-mist-400">{t(`settings.areas.${area.key}.text`)}</p>
          </div>
          <div className="space-y-6">
            <AreaContent key={area.slug} area={area.slug} />
          </div>
        </div>
      </div>
    </div>
  )
}

/** The address of before, `/about`: "About nexnotes" is an area of the settings now. */
export function FormerAboutAddress() {
  return <Navigate to={areaPath('about')} replace />
}

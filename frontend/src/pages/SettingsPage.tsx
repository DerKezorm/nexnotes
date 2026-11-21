/**
 * Settings (NOTES-2 AC-9): every account finds "My account" and "Connections"; the operator also "Server",
 * "Accounts" and "Log". The tab stands in the address (`/settings/server`), so a link can point at one; a tab someone
 * may not see falls back to "My account".
 */
import { Info, Plug, ScrollText, Server as ServerIcon, UserRound, Users } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useParams } from 'react-router-dom'

import { useTitle } from '../lib/title'
import { useAuth } from '../state/auth'
import { AccountsTab } from './settings/AccountsTab'
import { AccountTab } from './settings/AccountTab'
import { ConnectionsTab } from './settings/ConnectionsTab'
import { LogCard } from './settings/LogCard'
import { BackupsCard, FeaturesCard, LanguagesCard, LimitsCard, MailCard, OcrCard, ProxyHint, useServerSettings } from './settings/ServerCards'
import { SignInPart } from './settings/SignInCards'
import { TabRow, type Tab } from './settings/ui'

export type SettingsTab = 'account' | 'connections' | 'server' | 'accounts' | 'log'
const MEMBER_TABS: SettingsTab[] = ['account', 'connections']
const OPERATOR_TABS: SettingsTab[] = ['account', 'connections', 'server', 'accounts', 'log']
const ICON = { account: UserRound, connections: Plug, server: ServerIcon, accounts: Users, log: ScrollText }

export function SettingsPage() {
  const { t } = useTranslation()
  useTitle(t('settings.title'))
  const { me } = useAuth()
  const navigate = useNavigate()
  const { tab: asked } = useParams()
  const allowed = me?.role === 'operator' ? OPERATOR_TABS : MEMBER_TABS
  const tab: SettingsTab = asked && allowed.includes(asked as SettingsTab) ? (asked as SettingsTab) : 'account'
  const tabs: Tab<SettingsTab>[] = allowed.map((value) => ({ value, label: t(`settings.tabs.${value}`), icon: ICON[value] }))
  return (
    <div className="mx-auto max-w-4xl space-y-5 px-4 py-6 sm:px-6 sm:py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight text-mist-100">{t('settings.title')}</h1>
        <Link to="/about" className="nn-btn-quiet inline-flex items-center gap-1.5 text-sm">
          <Info className="h-4 w-4" aria-hidden />
          {t('about.title')}
        </Link>
      </div>
      <TabRow tabs={tabs} active={tab} onChange={(value) => navigate(value === 'account' ? '/settings' : `/settings/${value}`, { replace: true })} label={t('settings.title')} />
      <div className="space-y-6 pt-1">
        {tab === 'account' && <AccountTab />}
        {tab === 'connections' && <ConnectionsTab />}
        {tab === 'server' && <ServerTab />}
        {tab === 'accounts' && <AccountsTab />}
        {tab === 'log' && <LogCard />}
      </div>
    </div>
  )
}

/** The server, for the operator: limits, storage and backups, the switches, text recognition, sign-in, mail, languages. */
function ServerTab() {
  const server = useServerSettings()
  if (!server.settings) return null
  return (
    <div className="space-y-6" data-testid="server-tab">
      <ProxyHint server={server} />
      <LimitsCard server={server} />
      <BackupsCard server={server} />
      <FeaturesCard server={server} />
      <OcrCard server={server} />
      <SignInPart server={server} />
      <MailCard server={server} />
      <LanguagesCard />
    </div>
  )
}

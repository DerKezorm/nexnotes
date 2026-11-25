/**
 * Settings, "Accounts" (drawing N2-Konten): every account with its address, way of signing in, role, storage with its
 * limit and last use (NOTES-1 AC-7, NOTES-2 AC-7); never a title or a word of a note. Invite a person, block, delete
 * (30 days to bring it back), give a role, set a limit, a reset link (the person sets the new password, NOTES-2 AC-7),
 * sign out everywhere, take a provider's link. `?invite` in the address opens "Person einladen" at once (the share
 * dialog's link when nobody on the server goes by the name typed).
 */
import { Menu } from '../../components/Menu'
import { Avatar } from '../../components/Avatar'
import { Mail, MoreHorizontal, UserPlus } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'

import { accountsApi, invitesApi, oidcAdminApi, type AccountRow, type FactorResetOverview, type Invite, type LinkedProvider } from '../../api/client'
import { AccountButton } from '../../components/AccountButton'
import { confirmOf } from '../../lib/accountButton'
import { copyText } from '../../lib/copy'
import { bytes, day, dayTime } from '../../lib/format'
import { ago } from '../../lib/time'
import { useAuth } from '../../state/auth'
import { DISPLAY_NAME_MAX, FACTOR_RESET_DEFAULTS, factorResetParts, INVITE_DAYS, RESET_DAYS, RESET_DAYS_DEFAULT, USERNAME_MAX, type ButtonName } from '../../vendor/nexkonten/konten'
import { Button, Card, CheckboxRow, ConfirmDialog, Dialog, Field, Notice, Row, Rows, SelectField } from '../../vendor/nexui'
import { Feedback, useAction } from './ui'

/** The confirming button of each question, kind and symbol from the module's table (`BUTTONS`, konten 0.3.8). */
const CONFIRM_BUTTON: Record<Asking['kind'], ButtonName> = {
  block: 'blockAccount',
  unblock: 'unblockAccount',
  restore: 'confirm',
  signOut: 'signOut',
  resetFactor: 'account.factorReset',
  role: 'confirm',
  removeEmail: 'account.emailRemove',
  delete: 'removeAccount',
  unlink: 'oidc.account.unlink',
}

/** A link to hand on: the field to read it in and the button that copies it. */
function CopyField({ value, label }: { value: string; label: string }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex items-end gap-2">
      <div className="min-w-0 flex-1">
        <Field label={label} value={value} readOnly mono onFocus={(event) => event.target.select()} />
      </div>
      <AccountButton name="copy" onClick={() => void copyText(value).then(setCopied)}>
        {copied ? t('common.copied') : t('common.copy')}
      </AccountButton>
    </div>
  )
}

const GB = 1024 ** 3

type Asking =
  | { kind: 'block' | 'unblock' | 'restore' | 'signOut' | 'resetFactor' | 'role' | 'removeEmail'; row: AccountRow }
  | { kind: 'delete'; row: AccountRow; notes: number; shared: number; days: number }
  | { kind: 'unlink'; row: AccountRow; provider: LinkedProvider }

function wayIn(row: AccountRow, t: (key: string, values?: Record<string, unknown>) => string): string {
  if (row.providers.length > 0 && !row.has_password) return row.providers.map((entry) => entry.label).join(', ')
  const password = row.two_factor ? t('accounts.passwordTwoFactor') : t('accounts.password')
  return row.providers.length > 0 ? `${row.providers.map((entry) => entry.label).join(', ')} · ${password}` : password
}

export function AccountsTab() {
  const { t, i18n } = useTranslation()
  const { me } = useAuth()
  const [rows, setRows] = useState<AccountRow[] | null>(null)
  const [invites, setInvites] = useState<Invite[]>([])
  const [params, setParams] = useSearchParams()
  const [inviting, setInviting] = useState(() => params.has('invite'))
  const [menu, setMenu] = useState<{ id: number; anchor: HTMLElement } | null>(null)
  const [asking, setAsking] = useState<Asking | null>(null)
  const [limitFor, setLimitFor] = useState<AccountRow | null>(null)
  const [resetFor, setResetFor] = useState<AccountRow | null>(null)
  const [renaming, setRenaming] = useState<{ row: AccountRow; field: 'name' | 'display_name' } | null>(null)
  const [disconnect, setDisconnect] = useState<boolean>(FACTOR_RESET_DEFAULTS.factorResetDevices)
  const [removePasskeys, setRemovePasskeys] = useState<boolean>(FACTOR_RESET_DEFAULTS.factorResetPasskeys)
  /** What the reset takes away, loaded when the dialog opens (``factor.reset_overview``). */
  const [overview, setOverview] = useState<FactorResetOverview | null>(null)
  const action = useAction()
  const lang = i18n.language

  const load = useCallback(() => {
    accountsApi.list().then(setRows, () => setRows([]))
    invitesApi.list().then(setInvites, () => undefined)
  }, [])
  useEffect(load, [load])

  if (!rows || !me) return null
  const operatorPassword = me.sign_in === 'password'
  const living = rows.filter((row) => !row.deleted_at)

  return (
    <div className="space-y-6">
      <Card id="accounts" icon={UserPlus} title={t('accounts.title')} subtitle={t('accounts.lead', { count: living.length })}>
        <div>
          <AccountButton name="invite" onClick={() => setInviting(true)}>
            {t('accounts.invite')}
          </AccountButton>
        </div>
        <div className="overflow-x-auto rounded-[12px] border border-ink-700">
          <table className="w-full min-w-[720px] text-left text-sm" data-testid="account-table">
            <thead className="border-b border-ink-700 text-xs text-mist-500">
              <tr>
                <th className="px-3 py-2 font-medium">{t('accounts.person')}</th>
                <th className="px-3 py-2 font-medium">{t('accounts.signIn')}</th>
                <th className="px-3 py-2 font-medium">{t('accounts.role')}</th>
                <th className="px-3 py-2 font-medium">{t('accounts.storage')}</th>
                <th className="px-3 py-2 font-medium">{t('accounts.last')}</th>
                <th className="px-3 py-2 font-medium">
                  <span className="sr-only">{t('accounts.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-700">
              {rows.map((row) => {
                const shown = row.display_name || row.name
                const share = row.storage_limit ? Math.min(100, Math.round((row.storage_used / row.storage_limit) * 100)) : 0
                const out = !!row.deleted_at || row.blocked
                return (
                  <tr key={row.id} data-testid={`account-${row.name}`} className={out ? 'text-mist-500' : ''}>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <Avatar accountId={row.id} name={shown} stamp={row.avatar} className="bg-ink-700 text-mist-200" />
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-mist-100">
                            {shown}
                            {row.deleted_at ? ` (${t('accounts.deleted')})` : row.blocked ? ` (${t('accounts.blocked')})` : ''}
                          </span>
                          <span className="block truncate text-xs text-mist-500">{row.email ? `${row.name} · ${row.email}` : row.name}</span>
                          {row.email_duplicate && <span className="block text-xs text-warn-500">{t('account.emailDuplicate')}</span>}
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5">{wayIn(row, t)}</td>
                    <td className="px-3 py-2.5">{t(`roles.${row.role}`)}</td>
                    <td className="px-3 py-2.5">
                      <div className="text-xs">
                        {row.storage_limit
                          ? t('accounts.usedOf', { used: bytes(row.storage_used, lang), limit: bytes(row.storage_limit, lang) })
                          : t('accounts.usedNoLimit', { used: bytes(row.storage_used, lang) })}
                      </div>
                      <div className="mt-1 h-1.5 w-28 overflow-hidden rounded-full bg-ink-700">
                        <div className="h-full rounded-full" style={{ width: `${row.storage_limit ? Math.max(2, share) : 2}%`, background: share > 90 ? 'var(--color-warn-500)' : 'var(--color-progress)' }} />
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-xs">
                      {row.deleted_at && row.purge_at ? (
                        <span className="text-bad-500">{t('accounts.goesOn', { day: day(row.purge_at, lang) })}</span>
                      ) : row.blocked && row.blocked_at ? (
                        <span className="text-bad-500">{t('accounts.blockedSince', { day: day(row.blocked_at, lang) })}</span>
                      ) : row.last_seen_at ? (
                        <span title={dayTime(row.last_seen_at, lang)}>{ago(new Date(row.last_seen_at).getTime(), lang)}</span>
                      ) : (
                        t('accounts.never')
                      )}
                    </td>
                    <td className="relative px-3 py-2.5 text-right">
                      <button
                        type="button"
                        aria-label={t('accounts.actionsFor', { name: shown })}
                        aria-expanded={menu?.id === row.id}
                        aria-haspopup="menu"
                        className="nn-btn nn-btn-ghost h-8 w-8 px-0"
                        data-testid="account-menu-button"
                        onClick={(event) => setMenu(menu?.id === row.id ? null : { id: row.id, anchor: event.currentTarget })}
                      >
                        <MoreHorizontal className="h-4 w-4" aria-hidden />
                      </button>
                      {menu?.id === row.id && (
                        <Menu anchor={menu.anchor} onClose={() => setMenu(null)} label={t('accounts.actionsFor', { name: shown })} className="text-left" testId="account-menu">
                          {row.deleted_at ? (
                            <MenuItem onClick={() => setAsking({ kind: 'restore', row })}>{t('accounts.restore')}</MenuItem>
                          ) : (
                            <>
                              <MenuItem onClick={() => setAsking({ kind: 'role', row })}>{row.role === 'operator' ? t('accounts.makeMember') : t('accounts.makeOperator')}</MenuItem>
                              <MenuItem onClick={() => setLimitFor(row)}>{t('accounts.setLimit')}</MenuItem>
                              <MenuItem onClick={() => setRenaming({ row, field: 'display_name' })}>{t('accounts.changeDisplayName')}</MenuItem>
                              <MenuItem onClick={() => setRenaming({ row, field: 'name' })}>{t('accounts.changeUsername')}</MenuItem>
                              {row.email && <MenuItem onClick={() => setAsking({ kind: 'removeEmail', row })}>{t('account.emailRemove')}</MenuItem>}
                              <MenuItem onClick={() => setResetFor(row)}>{t('accounts.resetLink')}</MenuItem>
                              {(row.two_factor || !!row.passkeys) && (
                                <MenuItem
                                  onClick={() => {
                                    setOverview(null)
                                    setDisconnect(FACTOR_RESET_DEFAULTS.factorResetDevices)
                                    setRemovePasskeys(FACTOR_RESET_DEFAULTS.factorResetPasskeys)
                                    void accountsApi.resetOverview(row.id).then(setOverview, () => setOverview(null))
                                    setAsking({ kind: 'resetFactor', row })
                                  }}
                                >
                                  {t('accounts.resetFactor')}
                                </MenuItem>
                              )}
                              <MenuItem onClick={() => setAsking({ kind: 'signOut', row })}>{t('accounts.signOut')}</MenuItem>
                              {row.providers.map((provider) => (
                                <MenuItem key={provider.id} onClick={() => setAsking({ kind: 'unlink', row, provider })}>
                                  {t('accounts.unlink', { name: provider.label })}
                                </MenuItem>
                              ))}
                              {row.id !== me.id && (
                                <MenuItem onClick={() => setAsking({ kind: row.blocked ? 'unblock' : 'block', row })}>{row.blocked ? t('accounts.unblock') : t('accounts.block')}</MenuItem>
                              )}
                              {row.id !== me.id && (
                                <MenuItem
                                  danger
                                  onClick={() =>
                                    void action.run(async () => {
                                      const impact = await accountsApi.impact(row.id)
                                      setAsking({ kind: 'delete', row, ...impact })
                                    })
                                  }
                                >
                                  {t('accounts.delete')}
                                </MenuItem>
                              )}
                            </>
                          )}
                        </Menu>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <Feedback problem={action.problem} done={action.done} />
      </Card>

      {invites.length > 0 && (
        <Card id="invites" icon={UserPlus} title={t('accounts.openInvites')}>
          <Rows testId="invite-list">
            {invites.map((invite) => (
              <Row
                key={invite.id}
                icon={Mail}
                name={invite.email || t('accounts.inviteNoAddress')}
                detail={`${t(`roles.${invite.role}`)} · ${t('accounts.until', { day: day(invite.expires_at, lang) })}`}
                action={
                  <Button kind="danger" icon="Undo2" onClick={() => void action.run(async () => { await invitesApi.withdraw(invite.id); load() }, t('accounts.withdrawn'))}>
                    {t('accounts.withdraw')}
                  </Button>
                }
              />
            ))}
          </Rows>
        </Card>
      )}

      {inviting && (
        <InviteDialog
          onClose={() => {
            setInviting(false)
            if (params.has('invite')) {
              params.delete('invite')
              setParams(params, { replace: true })
            }
          }}
          onMade={load}
        />
      )}
      {limitFor && <LimitDialog row={limitFor} onClose={() => setLimitFor(null)} onSaved={load} />}
      {resetFor && <ResetLinkDialog row={resetFor} askOwn={operatorPassword} onClose={() => setResetFor(null)} />}
      {renaming && (
        <NameDialog row={renaming.row} field={renaming.field} askOwn={operatorPassword} onClose={() => setRenaming(null)} onSaved={load} />
      )}
      {asking && <Question asking={asking} askOwn={operatorPassword} overview={overview} disconnect={disconnect} setDisconnect={setDisconnect} removePasskeys={removePasskeys} setRemovePasskeys={setRemovePasskeys} onDone={() => { setAsking(null); setMenu(null); load() }} onCancel={() => setAsking(null)} />}
    </div>
  )
}

/** "Really?" for an act on an account, with the operator's own password where the server asks for it again. */
function Question({ asking, askOwn, overview, disconnect, setDisconnect, removePasskeys, setRemovePasskeys, onDone, onCancel }: {
  asking: Asking
  askOwn: boolean
  overview: FactorResetOverview | null
  disconnect: boolean
  setDisconnect: (value: boolean) => void
  removePasskeys: boolean
  setRemovePasskeys: (value: boolean) => void
  onDone: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const [password, setPassword] = useState('')
  const action = useAction()
  const row = asking.row
  const withPassword = askOwn && asking.kind !== 'signOut'
  const text =
    asking.kind === 'delete'
      ? t('accounts.confirm.delete.text', { notes: t('accounts.countNotes', { count: asking.notes }), shared: t('accounts.countShared', { count: asking.shared }), days: asking.days })
      : asking.kind === 'unlink'
        ? t('accounts.confirm.unlink.text', { name: asking.provider.label })
        : asking.kind === 'role'
          ? t(row.role === 'operator' ? 'accounts.confirm.role.toMember' : 'accounts.confirm.role.toOperator')
          : t(`accounts.confirm.${asking.kind}.text`)
  return (
    <ConfirmDialog
      title={t(`accounts.confirm.${asking.kind}.title`, { name: row.display_name || row.name })}
      text={text}
      confirm={confirmOf(CONFIRM_BUTTON[asking.kind], t(`accounts.confirm.${asking.kind}.button`))}
      cancel={t('common.cancel')}
      closeLabel={t('common.close')}
      busy={action.busy}
      confirmDisabled={withPassword && !password}
      onCancel={onCancel}
      onConfirm={() =>
        void action.run(async () => {
          if (asking.kind === 'delete') await accountsApi.remove(row.id, password)
          if (asking.kind === 'restore') await accountsApi.restore(row.id, password)
          if (asking.kind === 'block') await accountsApi.block(row.id, password)
          if (asking.kind === 'unblock') await accountsApi.unblock(row.id, password)
          if (asking.kind === 'signOut') await accountsApi.signOut(row.id)
          if (asking.kind === 'resetFactor') await accountsApi.resetSecondFactor(row.id, password, disconnect, removePasskeys && !!overview?.passkeys.length)
          if (asking.kind === 'removeEmail') await accountsApi.removeEmail(row.id, password)
          if (asking.kind === 'role') await accountsApi.role(row.id, row.role === 'operator' ? 'member' : 'operator', password)
          if (asking.kind === 'unlink') await oidcAdminApi.unlinkAccount(row.id, asking.provider.id, password)
          onDone()
        })
      }
    >
      {asking.kind === 'resetFactor' &&
        // The parts for this account (konten 0.3.4): the passkeys and their box only where it has some.
        factorResetParts({ passkeys: overview?.passkeys ?? [] }).map((part) => {
          if (part === 'factorResetHint') return <p key={part} className="m-0 text-sm">{t('account.factorResetHint')}</p>
          if (part === 'passkeys')
            return (
              <p key={part} className="m-0 text-sm">
                {t('account.passkeys')}: {(overview?.passkeys ?? []).map((key) => key.name).join(', ')}
              </p>
            )
          if (part === 'factorResetPasskeys') return <CheckboxRow key={part} label={t('account.factorResetPasskeys')} checked={removePasskeys} onChange={setRemovePasskeys} />
          if (part === 'factorResetDevices') return <CheckboxRow key={part} label={t('account.factorResetDevices')} checked={disconnect} onChange={setDisconnect} />
          return null
        })}
      {withPassword && <Field label={t('settings.ownPassword')} type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />}
      <Feedback problem={action.problem} />
    </ConfirmDialog>
  )
}

function MenuItem({ children, onClick, danger = false }: { children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button type="button" role="menuitem" onClick={onClick} className={'nn-menu-item ' + (danger ? 'text-bad-500 not-disabled:hover:text-bad-500' : '')}>
      <span className="truncate">{children}</span>
    </button>
  )
}

function InviteDialog({ onClose, onMade }: { onClose: () => void; onMade: () => void }) {
  const { t, i18n } = useTranslation()
  const { me } = useAuth()
  const [email, setEmail] = useState('')
  const [shownName, setShownName] = useState('')
  const [role, setRole] = useState<'member' | 'operator'>('member')
  const [days, setDays] = useState('7')
  const [send, setSend] = useState(false)
  const [made, setMade] = useState<{ link: string; sent: boolean; email: string } | null>(null)
  const action = useAction()
  // The switch shows only with a mail server, and counts only with an address: then the button sends (fourth review).
  const mailing = Boolean(me?.mail) && send && Boolean(email.trim())
  return (
    <Dialog title={t('accounts.invite')} onClose={onClose} closeLabel={t('common.close')}>
      {made ? (
        <div className="flex flex-col gap-3">
          {made.sent && (
            <Notice tone="ok" testId="invite-sent">
              {t('accounts.inviteSent', { email: made.email })}
            </Notice>
          )}
          <p className="m-0 text-sm">{t(made.sent ? 'accounts.inviteLinkToo' : 'accounts.inviteLink')}</p>
          <CopyField value={made.link} label={t('accounts.invite')} />
          <div className="flex justify-end">
            <AccountButton name="done" onClick={onClose}>
              {t('common.done')}
            </AccountButton>
          </div>
        </div>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            void action.run(async () => {
              const answer = await invitesApi.make({
                email: email.trim(),
                display_name: shownName.trim(),
                role,
                days: Number(days),
                send: mailing,
                language: i18n.language,
              })
              setMade({ link: answer.link, sent: answer.sent, email: email.trim() })
              onMade()
            })
          }}
        >
          <Field label={t('account.email')} type="email" value={email} onChange={(event) => setEmail(event.target.value)} hints={[t('accounts.inviteEmailHint')]} />
          <Field label={t('account.displayName')} value={shownName} onChange={(event) => setShownName(event.target.value)} maxLength={DISPLAY_NAME_MAX} />
          <div className="grid gap-3 sm:grid-cols-2">
            <SelectField label={t('accounts.role')} value={role} onChange={(event) => setRole(event.target.value as 'member' | 'operator')} options={[{ value: 'member', label: t('roles.member') }, { value: 'operator', label: t('roles.operator') }]} />
            <SelectField label={t('account.validFor')} value={days} onChange={(event) => setDays(event.target.value)} options={INVITE_DAYS.map((value) => ({ value: String(value), label: t('account.days', { count: value }) }))} />
          </div>
          {me?.mail && <CheckboxRow label={t('accounts.sendMail')} checked={send} onChange={setSend} disabled={!email.trim()} />}
          <Feedback problem={action.problem} />
          <div className="flex flex-wrap justify-end gap-2">
            <AccountButton name="cancel" onClick={onClose}>
              {t('common.cancel')}
            </AccountButton>
            <AccountButton name="invite" type="submit" disabled={action.busy} testId="invite-submit">
              {t(mailing ? 'accounts.inviteSend' : 'accounts.inviteMake')}
            </AccountButton>
          </div>
        </form>
      )}
    </Dialog>
  )
}

function LimitDialog({ row, onClose, onSaved }: { row: AccountRow; onClose: () => void; onSaved: () => void }) {
  const { t, i18n } = useTranslation()
  const [value, setValue] = useState(row.storage_limit ? String(Math.round((row.storage_limit / GB) * 10) / 10) : '')
  const action = useAction()
  const shown = row.display_name || row.name
  const save = (limit: number | null) =>
    void action.run(async () => {
      await accountsApi.limit(row.id, limit)
      onSaved()
      onClose()
    })
  return (
    <Dialog title={t('accounts.limitTitle', { name: shown })} onClose={onClose} closeLabel={t('common.close')}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          const gigabytes = Number(value.replace(',', '.'))
          if (!gigabytes || gigabytes <= 0) return
          save(Math.round(gigabytes * GB))
        }}
      >
        <p className="m-0 text-sm">{t('accounts.limitText')}</p>
        <Field label={t('accounts.limitField')} type="number" min={0} value={value} onChange={(event) => setValue(event.target.value)} hints={[t('accounts.limitUsed', { used: bytes(row.storage_used, i18n.language) })]} />
        <Feedback problem={action.problem} />
        <div className="flex flex-wrap justify-end gap-2">
          {row.storage_limit !== null && (
            <Button kind="danger" icon="X" onClick={() => save(null)}>
              {t('accounts.limitRemove')}
            </Button>
          )}
          <AccountButton name="confirm" type="submit" disabled={action.busy || !value}>
            {t('accounts.limitSet')}
          </AccountButton>
        </div>
      </form>
    </Dialog>
  )
}

/** Another username or display name for an account, with the operator's own password (the shared account module). */
function NameDialog({ row, field, askOwn, onClose, onSaved }: {
  row: AccountRow
  field: 'name' | 'display_name'
  askOwn: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const { t } = useTranslation()
  const [value, setValue] = useState(field === 'name' ? row.name : row.display_name)
  const [own, setOwn] = useState('')
  const action = useAction()
  const shown = row.display_name || row.name
  const label = field === 'name' ? t('account.username') : t('account.displayName')
  return (
    <Dialog title={field === 'name' ? t('accounts.changeUsername') : t('accounts.changeDisplayName')} onClose={onClose} closeLabel={t('common.close')}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          void action.run(async () => {
            if (field === 'name') await accountsApi.rename(row.id, value.trim(), own)
            else await accountsApi.displayName(row.id, value.trim(), own)
            onSaved()
            onClose()
          })
        }}
      >
        <p className="m-0 text-sm text-[var(--nexui-text-muted)]">{shown}</p>
        <Field
          label={label}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          maxLength={field === 'name' ? USERNAME_MAX : DISPLAY_NAME_MAX}
          hints={[field === 'name' ? t('account.usernameRules') : t('account.displayNameHint')]}
        />
        {askOwn && <Field label={t('settings.ownPassword')} type="password" autoComplete="current-password" value={own} onChange={(event) => setOwn(event.target.value)} />}
        <Feedback problem={action.problem} />
        <div className="flex flex-wrap justify-end gap-2">
          <AccountButton name="cancel" onClick={onClose}>
            {t('common.cancel')}
          </AccountButton>
          <AccountButton name="account.save" type="submit" disabled={action.busy || (askOwn && !own) || (field === 'name' && !value.trim())}>
            {t('common.save')}
          </AccountButton>
        </div>
      </form>
    </Dialog>
  )
}

/** The operator never sets another account's password (NOTES-2 AC-7): a one-time link lets the person do it; with a
 * mail server and an address it goes there. */
function ResetLinkDialog({ row, askOwn, onClose }: { row: AccountRow; askOwn: boolean; onClose: () => void }) {
  const { t } = useTranslation()
  const [days, setDays] = useState(String(RESET_DAYS_DEFAULT))
  const [own, setOwn] = useState('')
  const [link, setLink] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const action = useAction()
  const name = row.display_name || row.name
  return (
    <Dialog title={t('accounts.resetLinkFor', { name })} onClose={onClose} closeLabel={t('common.close')}>
      {sent ? (
        <div className="flex flex-col gap-3" data-testid="reset-link">
          <Notice tone="ok">{t('account.resetLinkSent', { email: row.email })}</Notice>
          <div className="flex justify-end">
            <AccountButton name="done" onClick={onClose}>
              {t('common.done')}
            </AccountButton>
          </div>
        </div>
      ) : link ? (
        <div className="flex flex-col gap-3" data-testid="reset-link">
          <p className="m-0 text-sm">{t('accounts.resetLinkShown', { name })}</p>
          <CopyField value={link} label={t('accounts.resetLink')} />
          <div className="flex justify-end">
            <AccountButton name="done" onClick={onClose}>
              {t('common.done')}
            </AccountButton>
          </div>
        </div>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            void action.run(async () => {
              const answer = await accountsApi.resetLink(row.id, Number(days), own)
              if (answer.sent) setSent(true)
              else setLink(answer.link)
            })
          }}
        >
          <p className="m-0 text-sm">{t('accounts.resetLinkText', { name })}</p>
          <SelectField label={t('account.validFor')} value={days} onChange={(event) => setDays(event.target.value)} options={RESET_DAYS.map((value) => ({ value: String(value), label: t('account.days', { count: value }) }))} />
          {askOwn && <Field label={t('settings.ownPassword')} type="password" autoComplete="current-password" value={own} onChange={(event) => setOwn(event.target.value)} />}
          <Feedback problem={action.problem} />
          <div className="flex flex-wrap justify-end gap-2">
            <AccountButton name="cancel" onClick={onClose}>
              {t('common.cancel')}
            </AccountButton>
            <AccountButton name="confirm" type="submit" disabled={action.busy || (askOwn && !own)}>
              {t('accounts.resetLinkMake')}
            </AccountButton>
          </div>
        </form>
      )}
    </Dialog>
  )
}

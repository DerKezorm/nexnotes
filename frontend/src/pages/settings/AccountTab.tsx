/**
 * Settings, "My account": Profile and Security as the shared account module lays them out (`PAGES`, konten 0.3.6: its
 * parts top to bottom, one under the other, with its headings, hints and buttons), then nexnotes' own parts after them
 * (`APP_PAGES`: "Sign out" of this browser, NOTES-2 AC-12; the providers; the cards of the features in
 * `ACCOUNT_SECTIONS`, the links for reading and the vault). Appearance stays nexnotes' own (this device, and the paper
 * of new notes; NOTES-22 AC-2 and AC-7). Each area of the settings shows its `part`; without one, all of it.
 */
import { KeyRound, LayoutList, LogOut, Palette, ShieldCheck, UserRound } from 'lucide-react'
import { useEffect, useId, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'

import { api, authApi, type Me, type MyProvider } from '../../api/client'
import { Dialog } from '../../components/Dialog'
import { DISPLAY_NAME_MAX, EMAIL_MAX, PAGES, screenFields, SECOND_FACTOR_STATE, USERNAME_MAX } from '../../vendor/nexkonten/konten'
import { pagePart } from './accountPages'
import { Notice, PasskeysBox, RemainingAccess, SecondFactorOffNotice, SessionsBox } from './SecurityBoxes'
import { ACCOUNT_SECTIONS } from '../../extensions'
import { Avatar } from '../../components/Avatar'
import { Done, Field, Problem } from '../../components/Field'
import { PasswordConfirmField } from '../../components/PasswordConfirm'
import { SignOutWaiting, useSignOut } from '../../components/SignOut'
import { ThemeSwitcher } from '../../components/ThemeSwitcher'
import { paperOf } from '../../editor/paper'
import { PaperPicker } from '../../editor/PaperPicker'
import { GuideCard } from '../../guide/GuideCard'
import { browserLanguage, changeLanguage, languageOptions, type LanguageOption } from '../../i18n'
import { LookSettings } from '../../notes/list/LookSettings'
import { copyText } from '../../lib/copy'
import { errorText, problemText, signInErrorText } from '../../lib/errors'
import { day } from '../../lib/format'
import { usePasswordConfirm } from '../../lib/passwordConfirm'
import { go } from '../../lib/providers'
import { useAuth } from '../../state/auth'
import { Card, saveAsFile } from './ui'

const QUIET = 'nn-btn nn-btn-ghost h-8 px-3 text-xs font-medium'
const LOUD = 'nn-btn nn-btn-accent'
const PLAIN = 'nn-btn nn-btn-ghost'

/** The part of "My account" an area of the settings shows. */
export type AccountPart = 'profile' | 'security' | 'appearance'

export function AccountTab({ part }: { part?: AccountPart } = {}) {
  const { t, i18n } = useTranslation()
  const shows = (which: AccountPart) => !part || part === which
  const { me, setMe, refresh } = useAuth()
  const [params] = useSearchParams()
  const [name, setName] = useState(me?.display_name ?? '')
  const [username, setUsername] = useState(me?.name ?? '')
  const [email, setEmail] = useState(me?.email ?? '')
  /** A new username or address asks for the own password first (the shared account module). */
  const [confirming, setConfirming] = useState(false)
  const [own, setOwn] = useState('')
  /** Taking the offered address of a provider asks for the own password first. */
  const [taking, setTaking] = useState(false)
  const [providers, setProviders] = useState<MyProvider[] | null>(null)
  const loadProviders = () => authApi.myProviders().then(setProviders, () => setProviders([]))
  useEffect(() => {
    void loadProviders()
  }, [])
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const again = usePasswordConfirm(next)
  const [linkPassword, setLinkPassword] = useState('')
  const [linking, setLinking] = useState<string | null>(null)
  const linkedSlug = params.get('linked')
  const [linkedShown, setLinkedShown] = useState(!!linkedSlug)
  const linkedLabel = providers?.find((entry) => entry.slug === linkedSlug)?.label
  const [done, setDone] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(params.get('error') ? signInErrorText(params.get('error')!) : null)
  const [busy, setBusy] = useState(false)
  const [languages, setLanguages] = useState<LanguageOption[]>([])
  useEffect(() => {
    void languageOptions().then(setLanguages)
  }, [])
  const languageHintId = useId()

  if (!me) return null

  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true)
    setProblem(null)
    setDone(null)
    setLinkedShown(false)
    try {
      await action()
      setDone(success)
      await refresh()
    } catch (error) {
      if (error instanceof Notice) {
        setDone(error.message)
        await refresh()
      } else setProblem(problemText(error))
    } finally {
      setBusy(false)
    }
  }

  // The provider's name the server kept with the offer (konten 0.3.4); without one the linked provider's, else a word.
  const offerFrom = me.provider_email_from || (providers?.find((entry) => entry.linked)?.label ?? t('oidc.authentik.step.provider'))
  const takeOffer = (password: string) =>
    run(async () => {
      const saved = await authApi.takeProviderEmail(password)
      setEmail(saved.email)
      setMe(saved)
      if (saved.pending_email) throw new Notice(t('account.emailConfirmSent', { email: saved.pending_email }))
    }, t('me.emailTaken'))

  /** The hints under a field of the profile, each joined to it by aria-describedby (konten 0.3.7, `screenFields`). */
  const hintsOf = (field: 'displayName' | 'username' | 'email') =>
    (screenFields('profile').find((entry) => entry.field === field)?.hints ?? []).map((key) => t(key))

  const saveProfile = (password: string) =>
    run(async () => {
      const before = me.pending_email ?? ''
      const saved = await authApi.profile({
        display_name: name,
        email: email.trim(),
        ...(username.trim().toLowerCase() !== me.name ? { name: username.trim() } : {}),
        ...(password ? { password } : {}),
      })
      setName(saved.display_name)
      setUsername(saved.name)
      setEmail(saved.email)
      setMe(saved)
      if (saved.pending_email && saved.pending_email !== before) {
        // With a mail server the new address waits for its link; until then the old one counts.
        throw new Notice(t('account.emailConfirmSent', { email: saved.pending_email }))
      }
    }, t('me.profile.saved'))

  return (
    <div className="space-y-5">
      <SecondFactorOffNotice on={me.second_factor_off} />
      {me.new_password_origin && <RemainingAccess onDone={() => void refresh()} />}
      <div aria-live="polite">
        <Problem text={problem} />
        <Done text={done ?? (linkedShown && linkedLabel ? t('me.linked', { name: linkedLabel }) : null)} />
      </div>

      {shows('profile') && (
        <Card id="profile" icon={UserRound} title={t(PAGES.profile.title)}>
          <div className="space-y-2 text-sm" data-testid="profile-picture">
            <div>
              <h3 className="font-medium text-mist-100">{t(pagePart('profile', 'picture').title)}</h3>
              <p className="mt-0.5 text-xs text-mist-500">{t(pagePart('profile', 'picture').hint)}</p>
            </div>
            <div className="flex items-center gap-3">
              <Avatar accountId={me.id} name={me.display_name || me.name} stamp={me.avatar} size={56} />
              <div className="flex flex-wrap gap-2">
                <label className={PLAIN + ' cursor-pointer'}>
                  {t('account.pictureUpload')}
                  <input
                    type="file"
                    accept="image/*"
                    className="sr-only"
                    data-testid="picture-file"
                    onChange={(event) => {
                      const file = event.target.files?.[0]
                      event.target.value = ''
                      if (file) void run(async () => setMe(await authApi.avatar(file)), t('me.picture.saved'))
                    }}
                  />
                </label>
                {me.avatar && (
                  <button type="button" disabled={busy} className={QUIET} onClick={() => void run(async () => setMe(await authApi.removeAvatar()), t('me.picture.removed'))}>
                    {t('account.pictureRemove')}
                  </button>
                )}
              </div>
            </div>
          </div>
          {/* One under the other, also on a wide screen (`layout: 'stacked'`). One button saves display name,
              username and email together, never leaving a field (konten 0.3.7, `PAGES.profile.save`); a new username
              or address asks for the password first (`confirmOnSave`). */}
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault()
              const changed = { username: username.trim().toLowerCase() !== me.name, email: email.trim().toLowerCase() !== (me.email ?? '').toLowerCase() }
              const weighty = PAGES.profile.confirmOnSave.some((field) => changed[field])
              // An account with a password confirms a new username or address with it; one through a provider only
              // is asked for a fresh sign-in there by the server.
              if (weighty && me.sign_in === 'password') return setConfirming(true)
              void saveProfile('')
            }}
          >
            <Field label={t(pagePart('profile', 'displayName').title)} value={name} onChange={setName} autoComplete="name" maxLength={DISPLAY_NAME_MAX} hints={hintsOf('displayName')} />
            <div>
              <Field label={t(pagePart('profile', 'username').title)} value={username} onChange={setUsername} autoComplete="username" maxLength={USERNAME_MAX} hints={hintsOf('username')} />
              {me.former_name && <p className="mt-1 text-xs text-mist-500">{t('account.formerUsername')}</p>}
            </div>
            <div>
              <Field label={t(pagePart('profile', 'email').title)} value={email} onChange={setEmail} type="email" autoComplete="email" maxLength={EMAIL_MAX} hints={hintsOf('email')} />
              {me.pending_email && (
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-mist-400" data-testid="email-pending">
                  <span>{t('account.emailPending', { email: me.pending_email })}</span>
                  <button type="button" disabled={busy} className={QUIET} onClick={() => void run(async () => setMe(await authApi.resendEmail()), t('account.emailConfirmSent', { email: me.pending_email }))}>
                    {t('account.emailResend')}
                  </button>
                  <button type="button" disabled={busy} className={QUIET} onClick={() => void run(async () => setMe(await authApi.withdrawEmail()), '')}>
                    {t('account.emailWithdraw')}
                  </button>
                </div>
              )}
            </div>
            <div className="flex justify-end">
              <button
                type="submit"
                disabled={busy || (name.trim() === me.display_name && email.trim() === (me.email ?? '') && username.trim().toLowerCase() === me.name)}
                className={LOUD}
              >
                {t(PAGES.profile.saveButton)}
              </button>
            </div>
          </form>
          {confirming && (
            <Dialog title={t('account.confirmWithPassword')} onClose={() => setConfirming(false)}>
              <form
                className="space-y-3"
                onSubmit={(event) => {
                  event.preventDefault()
                  setConfirming(false)
                  void saveProfile(own)
                  setOwn('')
                }}
              >
                <Field label={t('account.currentPassword')} value={own} onChange={setOwn} type="password" autoComplete="current-password" autoFocus />
                <div className="flex justify-end gap-2">
                  <button type="button" className={PLAIN} onClick={() => setConfirming(false)}>
                    {t('common.cancel')}
                  </button>
                  <button type="submit" disabled={!own} className={LOUD}>
                    {t('account.save')}
                  </button>
                </div>
              </form>
            </Dialog>
          )}
          {me.provider_email && (
            <div data-testid="mail-offer" className="rounded-[12px] border border-accent-700/40 bg-[var(--color-accent-wash)] px-3.5 py-3 text-sm">
              {/* The shared account module (0.3.3; the provider's name since 0.3.4): an account with a password is only
                  offered the address and takes it like a change of address, with its password; "No, thanks" holds
                  for this address for good. */}
              <p className="font-medium text-mist-100">{t(pagePart('profile', 'providerEmailOffer').title, { provider: offerFrom })}</p>
              <p className="text-mist-300">{me.provider_email}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busy}
                  className={LOUD}
                  onClick={() => (me.sign_in === 'password' ? setTaking(true) : void takeOffer(''))}
                >
                  {t('account.providerEmailTake')}
                </button>
                <button type="button" disabled={busy} className={PLAIN} onClick={() => void run(() => authApi.declineProviderEmail(), t('me.emailDeclined'))}>
                  {t('account.providerEmailDismiss')}
                </button>
              </div>
            </div>
          )}
          {taking && (
            <Dialog title={t('account.confirmWithPassword')} onClose={() => setTaking(false)}>
              <form
                className="space-y-3"
                onSubmit={(event) => {
                  event.preventDefault()
                  setTaking(false)
                  void takeOffer(own)
                  setOwn('')
                }}
              >
                <Field label={t('account.currentPassword')} value={own} onChange={setOwn} type="password" autoComplete="current-password" autoFocus />
                <div className="flex justify-end gap-2">
                  <button type="button" className={PLAIN} onClick={() => setTaking(false)}>
                    {t('common.cancel')}
                  </button>
                  <button type="submit" disabled={!own} className={LOUD}>
                    {t('account.providerEmailTake')}
                  </button>
                </div>
              </form>
            </Dialog>
          )}
          <div className="text-sm">
            <label className="block">
              <span className="font-medium text-mist-100">{t(pagePart('profile', 'language').title)}</span>
              <select
                className="nn-field mt-1"
                value={me.language}
                aria-describedby={languageHintId}
                data-testid="language-select"
                onChange={(event) => {
                  const code = event.target.value
                  void run(async () => {
                    const saved = await authApi.language(code)
                    setMe(saved)
                    await changeLanguage(code || browserLanguage(), !!code)
                  }, '')
                }}
              >
                <option value="">{t('me.looks.browser')}</option>
                {languages.map((option) => (
                  <option key={option.code} value={option.code}>
                    {option.added ? `${option.name} ${t('me.looks.byOperator')}` : option.name}
                  </option>
                ))}
              </select>
            </label>
            <span id={languageHintId} className="mt-1 block text-xs text-mist-500">
              {t('me.looks.languageHint')}
            </span>
          </div>
          <p className="text-xs text-mist-500" data-testid="profile-role">
            {t(pagePart('profile', 'role').title)}: {t(`roles.${me.role}`)}
          </p>
        </Card>
      )}

      {shows('profile') && <SignOutCard viaProvider={me.sign_in === 'oidc'} />}

      {shows('security') && (
        <Card id="security" icon={ShieldCheck} title={t(PAGES.security.title)}>
          {me.second_factor_setup_required && (
            <p role="note" className="rounded-[9px] border border-warn-500/40 bg-warn-500/10 px-4 py-3 text-sm text-warn-500">
              {t('me.setupFirst')}
            </p>
          )}

          {me.sign_in === 'password' && (
            <details className="rounded-[12px] border border-ink-700 px-3 py-2.5 text-sm" data-testid="password-row">
              <summary className="flex cursor-pointer list-none items-center gap-3">
                <KeyRound className="h-4 w-4 text-mist-500" aria-hidden />
                <span className="flex-1 font-medium text-mist-100">{t(pagePart('security', 'password').title)}</span>
                <span className="text-xs text-mist-500">
                  {me.password_changed_at ? t('me.password.changedAt', { day: day(me.password_changed_at, i18n.language) }) : ''}
                </span>
                <span className={QUIET}>{t('account.passwordChange')}</span>
              </summary>
              <form
                className="mt-3 space-y-3"
                onSubmit={(event) => {
                  event.preventDefault()
                  if (!current) return setProblem(errorText('current_password_missing'))
                  if (!next) return setProblem(errorText('password_missing'))
                  setProblem(null)
                  if (!again.matches()) return
                  void run(async () => {
                    await authApi.password(current, next, again.confirm)
                    setCurrent('')
                    setNext('')
                    again.clear()
                  }, t('me.password.done'))
                }}
              >
                <Field label={t('me.password.current')} value={current} onChange={setCurrent} type="password" autoComplete="current-password" />
                <Field label={t('me.password.new')} value={next} onChange={setNext} type="password" autoComplete="new-password" hint={t('setup.passwordHint', { count: me.min_password ?? 12 })} />
                <PasswordConfirmField value={again.confirm} onChange={again.setConfirm} mismatch={again.mismatch} labelClassName="font-medium text-mist-100" />
                <button type="submit" disabled={busy} className={LOUD}>
                  {t('me.password.submit')}
                </button>
              </form>
            </details>
          )}

          <SecondFactor me={me} />

          <PasskeysBox signedInByPassword={me.sign_in === 'password'} />

          <SessionsBox busy={busy} onEverywhere={() => run(() => authApi.logoutEverywhere(), t('me.sessions.done'))} />

          <label className="flex items-start gap-2 rounded-[12px] border border-ink-700 px-3 py-2.5 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={me.new_sign_in_mail !== false}
              disabled={busy}
              onChange={(event) => {
                const on = event.target.checked
                void run(async () => setMe(await authApi.newSignInMail(on)), '')
              }}
            />
            <span>
              <span className="font-medium text-mist-100">{t(pagePart('security', 'newSignInMail').title)}</span>
              <span className="block text-xs text-mist-500">{t(pagePart('security', 'newSignInMail').hint)}</span>
            </span>
          </label>

          {/* nexnotes' own parts come after the module's (`pageOrder`): the providers. */}
          {providers !== null && (providers.length > 0 || me.sign_in === 'oidc') && (
            <ul className="divide-y divide-ink-700 rounded-[12px] border border-ink-700" data-testid="my-providers" aria-label={t('oidc.account.title')}>
              {providers.map((provider) => {
                // The last link of an account without a password stays: it would lock the account out.
                const lastLink = me.sign_in === 'oidc' && provider.linked && providers.filter((entry) => entry.linked).length === 1
                return (
                  <li key={provider.slug} className="px-3 py-2.5 text-sm">
                    <div className="flex flex-wrap items-center gap-3">
                      <span className="min-w-0 flex-1 truncate font-medium text-mist-100">{provider.label}</span>
                      <span className={`rounded-full px-2 py-0.5 text-xs ${provider.linked ? 'bg-ok-500/10 text-ok-500' : 'border border-ink-700 text-mist-400'}`}>
                        {provider.linked ? t('oidc.account.linked') : t('oidc.account.notLinked')}
                      </span>
                      {provider.linked && !lastLink && (
                        <button
                          type="button"
                          disabled={busy}
                          className={QUIET}
                          onClick={() =>
                            void run(async () => {
                              await authApi.unlink(provider.slug)
                              await loadProviders()
                            }, t('me.unlinked', { name: provider.label }))
                          }
                        >
                          {t('oidc.account.unlink')}
                        </button>
                      )}
                      {!provider.linked && me.sign_in === 'password' && linking !== provider.slug && (
                        <button type="button" disabled={busy} className={QUIET} onClick={() => setLinking(provider.slug)}>
                          {t('oidc.account.link')}
                        </button>
                      )}
                    </div>
                    {lastLink && <p className="mt-1 text-xs text-mist-500">{t('oidc.account.only', { name: provider.label })}</p>}
                    {linking === provider.slug && (
                      <form
                        className="mt-3 flex flex-wrap items-end gap-2"
                        onSubmit={(event) => {
                          event.preventDefault()
                          setBusy(true)
                          setProblem(null)
                          authApi.linkStart(provider.slug, linkPassword).then(
                            ({ url }) => go(url),
                            (error) => {
                              setProblem(problemText(error))
                              setBusy(false)
                            },
                          )
                        }}
                      >
                        <div className="min-w-0 flex-1">
                          <Field label={t('auth.password')} value={linkPassword} onChange={setLinkPassword} type="password" autoComplete="current-password" />
                        </div>
                        <button type="submit" disabled={busy} className={PLAIN}>
                          {t('oidc.account.link')}
                        </button>
                      </form>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </Card>
      )}

      {shows('appearance') && (
        <Card id="looks" icon={Palette} title={t('me.looks.title')}>
          <div className="text-sm">
            <span className="font-medium">{t('me.looks.appearance')}</span> <span className="text-xs text-mist-500">{t('me.looks.appearanceHint')}</span>
            <div className="mt-1.5">
              <ThemeSwitcher withWords />
            </div>
          </div>
          <div className="text-sm">
            <span className="font-medium">{t('me.looks.paper')}</span> <span className="text-xs text-mist-500">{t('me.looks.paperHint')}</span>
            <div className="mt-1.5">
              <PaperPicker value={paperOf(me.paper)} onChange={(paper) => void run(async () => setMe(await authApi.paper(paper)), '')} />
            </div>
          </div>
        </Card>
      )}
      {shows('appearance') && (
        <Card id="lists" icon={LayoutList} title={t('me.lists.title')}>
          <LookSettings />
        </Card>
      )}
      {shows('appearance') && <GuideCard />}
      {shows('security') &&
        ACCOUNT_SECTIONS.map((section) => (
          <div key={section.key}>{section.render()}</div>
        ))}
    </div>
  )
}

/** Below this many recovery codes the account is told to make new ones. */
const LOW_CODES = 3

type Enrolment = { secret: string; uri: string; qr_svg: string; expires_at?: string | null }

const BOX = 'rounded-[12px] border border-ink-700 px-3 py-2.5 text-sm'

/**
 * Two parts of the module's security page (`PAGES`, konten 0.3.6): the second factor, its state beside the heading
 * ("On"/"Off", `SECOND_FACTOR_STATE`), set up (scan the code, type one code and the password) and remove; then the
 * recovery codes, how many are left, and new ones. A setup that waits for its first code comes back after a reload
 * (`GET /api/auth/totp/setup`, `factor.pending_setup`). Recovery codes are shown once, right after they were made, to
 * copy or save as a file.
 */
function SecondFactor({ me }: { me: Me }) {
  const { t } = useTranslation()
  const { refresh } = useAuth()
  const [enrolment, setEnrolment] = useState<Enrolment | null>(null)
  const [asking, setAsking] = useState<'disable' | 'renew' | null>(null)
  const [digits, setDigits] = useState('')
  const [password, setPassword] = useState('')
  const [codes, setCodes] = useState<string[] | null>(null)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    if (me.sign_in !== 'password' || me.two_factor) return
    let live = true
    api<{ waiting: boolean } & Partial<Enrolment>>('/api/auth/totp/setup').then(
      (held) => {
        if (live && held.waiting && held.secret && held.uri && held.qr_svg) setEnrolment({ secret: held.secret, uri: held.uri, qr_svg: held.qr_svg, expires_at: held.expires_at })
      },
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [me.sign_in, me.two_factor])

  const factor = pagePart('security', 'secondFactor')
  const recovery = pagePart('security', 'recoveryCodes')
  const state = SECOND_FACTOR_STATE[(me.factor_state ?? (me.two_factor ? 'active' : 'none')) as keyof typeof SECOND_FACTOR_STATE] ?? SECOND_FACTOR_STATE.none

  const close = () => {
    setEnrolment(null)
    setAsking(null)
    setDigits('')
    setPassword('')
    setProblem(null)
  }

  const act = async (work: () => Promise<void>) => {
    setBusy(true)
    setProblem(null)
    try {
      await work()
    } catch (error) {
      setProblem(problemText(error))
    } finally {
      setBusy(false)
    }
  }

  const codesText = (codes ?? []).join('\n')
  const head = (title: string, hint: string, beside?: ReactNode) => (
    <div className="mb-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="flex-1 font-medium text-mist-100">{title}</h3>
        {beside}
      </div>
      <p className="mt-0.5 text-xs text-mist-500">{hint}</p>
    </div>
  )

  return (
    <>
      <div className={BOX} data-testid="second-factor">
        {head(
          t(factor.title),
          t(factor.hint),
          <span className={`rounded-full px-2 py-0.5 text-xs ${state === SECOND_FACTOR_STATE.active ? 'bg-ok-500/10 text-ok-500' : 'border border-ink-700 text-mist-400'}`} data-testid="second-factor-state">
            {t(state)}
          </span>,
        )}
        {me.sign_in !== 'password' ? (
          <p className="text-mist-400">{t('twofactor.provider')}</p>
        ) : enrolment ? (
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault()
              void act(async () => {
                const result = await api<{ recovery_codes: string[] }>('/api/auth/totp/confirm', { method: 'POST', body: { code: digits.trim(), password } })
                close()
                setCodes(result.recovery_codes)
              })
            }}
          >
            <p className="text-mist-300">{t('twofactor.scan')}</p>
            <div className="flex justify-center">
              <img src={'data:image/svg+xml;utf8,' + encodeURIComponent(enrolment.qr_svg)} alt={t('twofactor.qr')} width={196} height={196} className="rounded-[9px] bg-white p-2" />
            </div>
            <p className="text-xs text-mist-500">{t('twofactor.secret')}</p>
            <code className="block rounded-[9px] bg-ink-950 px-3 py-2 font-mono text-xs break-all text-mist-200" data-testid="totp-secret">
              {enrolment.secret.replace(/(.{4})/g, '$1 ').trim()}
            </code>
            <Field label={t('twofactor.code')} value={digits} onChange={setDigits} autoComplete="one-time-code" autoFocus />
            <Field label={t('auth.password')} value={password} onChange={setPassword} type="password" autoComplete="current-password" hint={t('twofactor.passwordHint')} />
            <Problem text={problem} />
            <div className="flex justify-end gap-2">
              <button type="button" onClick={close} className={PLAIN}>
                {t('common.cancel')}
              </button>
              <button type="submit" disabled={busy || digits.trim().length !== 6 || !password} className={LOUD}>
                {t('twofactor.confirm')}
              </button>
            </div>
          </form>
        ) : asking === 'disable' ? (
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault()
              void act(async () => {
                await api('/api/auth/totp/disable', { method: 'POST', body: { password } })
                close()
                await refresh()
              })
            }}
          >
            <p className="text-mist-300">{t('twofactor.disableText')}</p>
            <Field label={t('auth.password')} value={password} onChange={setPassword} type="password" autoComplete="current-password" autoFocus />
            <Problem text={problem} />
            <div className="flex justify-end gap-2">
              <button type="button" onClick={close} className={PLAIN}>
                {t('common.cancel')}
              </button>
              <button type="submit" disabled={busy || !password} className="nn-btn nn-btn-danger">
                {t('account.totpRemove')}
              </button>
            </div>
          </form>
        ) : (
          <div className="space-y-2">
            {asking !== 'renew' && <Problem text={problem} />}
            {me.two_factor ? (
              <button type="button" className={QUIET} onClick={() => setAsking('disable')}>
                {t('account.totpRemove')}
              </button>
            ) : (
              <button type="button" disabled={busy} className={LOUD} onClick={() => void act(async () => setEnrolment(await api<Enrolment>('/api/auth/totp/begin', { method: 'POST' })))}>
                {t('account.totpSetup')}
              </button>
            )}
          </div>
        )}
      </div>

      {me.sign_in === 'password' && (me.two_factor || codes) && (
        <div className={BOX} data-testid="recovery-part">
          {head(t(recovery.title), t(recovery.hint))}
          {codes ? (
            <div className="space-y-3 rounded-[12px] border border-accent-700/40 bg-[var(--color-accent-wash)] p-3" data-testid="recovery-codes">
              <p className="font-semibold text-mist-100">{t('twofactor.codesTitle')}</p>
              <p className="text-xs text-mist-400">{t('twofactor.codesLead')}</p>
              <ol className="grid grid-cols-2 gap-2 rounded-[9px] bg-ink-950 px-4 py-3 font-mono text-sm text-mist-100">
                {codes.map((entry) => (
                  <li key={entry}>{entry}</li>
                ))}
              </ol>
              <div className="flex flex-wrap gap-2">
                <button type="button" className={QUIET} onClick={() => void copyText(codesText).then(setCopied)}>
                  {copied ? t('common.copied') : t('twofactor.codesCopy')}
                </button>
                <button type="button" className={QUIET} onClick={() => saveAsFile(`nexnotes-recovery-codes-${me.name}.txt`, new Blob([codesText + '\n'], { type: 'text/plain' }))}>
                  {t('twofactor.codesDownload')}
                </button>
                <button
                  type="button"
                  className={LOUD}
                  onClick={() => {
                    setCodes(null)
                    setCopied(false)
                    void refresh()
                  }}
                >
                  {t('twofactor.codesDone')}
                </button>
              </div>
            </div>
          ) : asking === 'renew' ? (
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault()
                void act(async () => {
                  const result = await api<{ recovery_codes: string[] }>('/api/auth/totp/recovery', { method: 'POST', body: { password } })
                  close()
                  setCodes(result.recovery_codes)
                })
              }}
            >
              <p className="text-mist-300">{t('twofactor.renewText')}</p>
              <Field label={t('auth.password')} value={password} onChange={setPassword} type="password" autoComplete="current-password" autoFocus />
              <Problem text={problem} />
              <div className="flex justify-end gap-2">
                <button type="button" onClick={close} className={PLAIN}>
                  {t('common.cancel')}
                </button>
                <button type="submit" disabled={busy || !password} className={LOUD}>
                  {t('account.recoveryCodesNew')}
                </button>
              </div>
            </form>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-mist-300">{t('account.recoveryLeft', { count: me.two_factor_recovery_left })}</span>
              <button type="button" className={QUIET} onClick={() => setAsking('renew')}>
                {t('account.recoveryCodesNew')}
              </button>
            </div>
          )}
          {!codes && me.two_factor && me.two_factor_recovery_left < LOW_CODES && (
            <p role="note" className="mt-2 rounded-[9px] border border-warn-500/40 bg-warn-500/10 px-3 py-2 text-xs text-warn-500">
              {t('twofactor.lowCodes')}
            </p>
          )}
        </div>
      )}
    </>
  )
}

/**
 * "Sign out" (NOTES-2 AC-12), the one button for it, here in the profile; on a phone the settings are the same page.
 * Changes that still wait ask first, as in the session's dialog. A provider's own session stays: only nexnotes ends.
 */
function SignOutCard({ viaProvider }: { viaProvider: boolean }) {
  const { t } = useTranslation()
  const leaving = useSignOut()
  return (
    <Card id="sign-out" icon={LogOut} title={t('me.signOut.title')} text={t('me.signOut.text')}>
      <div data-testid="sign-out-card" className="space-y-3">
        {viaProvider && <p className="text-xs text-mist-500">{t('me.signOut.provider')}</p>}
        {leaving.waiting > 0 ? (
          <SignOutWaiting count={leaving.waiting} onAnyway={leaving.anyway} onWait={leaving.wait} />
        ) : (
          <button type="button" className={PLAIN} data-testid="sign-out" onClick={leaving.ask}>
            {t('me.signOut.button')}
          </button>
        )}
      </div>
    </Card>
  )
}

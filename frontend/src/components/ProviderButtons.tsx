/**
 * The sign-in providers as buttons, in the order of the operator's list: on the sign-in page "Sign in with …" at the top
 * (the line "or" and the password form below them), on the invitation page "Continue with …" below the line "or" (the
 * invitation travels along to the provider).
 * Words from the shared sign-in module (`oidc.login.*`, `oidc.invite.button`), the same in every nex app.
 */
import { useTranslation } from 'react-i18next'

import type { ProviderButton } from '../api/client'
import { go, startAddress } from '../lib/providers'

export function OrLine() {
  const { t } = useTranslation()
  return (
    <div className="my-4 flex items-center gap-3 text-xs text-mist-600">
      <span className="h-px flex-1 bg-ink-700" />
      {t('oidc.login.or')}
      <span className="h-px flex-1 bg-ink-700" />
    </div>
  )
}

export function ProviderButtons({
  providers,
  invite,
  next,
  withOr = true,
  autoFocus = false,
}: {
  providers: ProviderButton[]
  /** The invitation's key: the buttons say "Continue with" and take it along. */
  invite?: string
  /** The page a direct link asked for: the sign-in lands there. */
  next?: string
  /** The line "or" above, when something stands before the buttons. */
  withOr?: boolean
  /** The first button takes the focus when the page opens (the sign-in page, where the buttons stand first). */
  autoFocus?: boolean
}) {
  const { t } = useTranslation()
  if (providers.length === 0) return null
  return (
    <>
      {withOr && <OrLine />}
      <div className="space-y-2" data-testid="provider-buttons">
        {providers.map((provider, index) => (
          <button
            key={provider.slug}
            type="button"
            autoFocus={autoFocus && index === 0}
            onClick={() => go(startAddress(provider.slug, { invite, next }))}
            className="nn-btn nn-btn-ghost w-full"
          >
            {invite ? t('oidc.invite.button', { name: provider.label }) : t('oidc.login.button', { name: provider.label })}
          </button>
        ))}
      </div>
    </>
  )
}

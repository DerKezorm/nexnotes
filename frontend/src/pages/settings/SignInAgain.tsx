/**
 * An account that signs in through a provider confirms an operator act (or a new vault, NOTES-16 EC-2) with a fresh
 * sign-in there: a small button per provider of the account, back to this page afterwards (the server asks the
 * provider for `prompt=login`). From the ui kit.
 */
import { useTranslation } from 'react-i18next'

import { go, startAddress } from '../../lib/providers'
import { Button, Buttons } from '../../vendor/nexui'

export function SignInAgain({ providers }: { providers: unknown }) {
  const { t } = useTranslation()
  const list = Array.isArray(providers) ? (providers as { slug: string; label: string }[]) : []
  const here = window.location.pathname + window.location.search
  return (
    <div className="mt-2" data-testid="sign-in-again">
      <Buttons>
        {list.map((provider) => (
          <Button key={provider.slug} kind="secondary" icon="LogIn" size="sm" onClick={() => go(startAddress(provider.slug, { next: here, fresh: true }))}>
            {t('oidc.login.button', { name: provider.label })}
          </Button>
        ))}
      </Buttons>
    </div>
  )
}

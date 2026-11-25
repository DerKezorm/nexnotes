/**
 * What a change in a card of the settings came to, in the kit's boxes: what went wrong (`Notice danger`, the sentence
 * of the server's code with its values; an operator from a provider gets the way to a fresh sign-in there), or that it
 * worked (`Notice ok`). Nothing when there is nothing to say.
 */
import { ApiError } from '../../api/client'
import { errorText, problemText } from '../../lib/errors'
import { Notice } from '../../vendor/nexui'
import type { Trouble } from './actions'
import { SignInAgain } from './SignInAgain'

export function Outcome({ problem, done = null, testId }: { problem: Trouble; done?: string | null; testId?: string }) {
  if (!problem && !done) return null
  return (
    <div aria-live="polite" data-testid={testId}>
      {problem ? (
        <Notice tone="danger">
          {typeof problem === 'string' ? errorText(problem) : problemText(problem)}
          {problem instanceof ApiError && problem.code === 'fresh_sign_in_required' && <SignInAgain providers={problem.values.providers} />}
        </Notice>
      ) : (
        <Notice tone="ok">{done}</Notice>
      )}
    </div>
  )
}

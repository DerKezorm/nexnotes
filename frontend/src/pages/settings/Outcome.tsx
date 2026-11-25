/**
 * What a change in a card of the settings came to, in the kit's boxes: what went wrong (`Notice danger`, the sentence
 * of the server's code with its values), or that it worked (`Notice ok`). Nothing when there is nothing to say.
 */
import { errorText, problemText } from '../../lib/errors'
import { Notice } from '../../vendor/nexui'
import type { Trouble } from './actions'

export function Outcome({ problem, done = null, testId }: { problem: Trouble; done?: string | null; testId?: string }) {
  if (!problem && !done) return null
  return (
    <div aria-live="polite" data-testid={testId}>
      {problem ? <Notice tone="danger">{typeof problem === 'string' ? errorText(problem) : problemText(problem)}</Notice> : <Notice tone="ok">{done}</Notice>}
    </div>
  )
}

/**
 * Who else is in the note, at the top (NOTES-12 AC-5): their initials in their colours, "Anna und Lena sind auch
 * hier", four initials and "+n" for more (EC-6), and one's own other windows as "du, anderes Fenster" (EC-8).
 */
import { useTranslation } from 'react-i18next'

import { OWN_COLOR, presenceSentence, SHOWN_PEOPLE, type Presence } from './presence'

export function PresenceBar({ presence }: { presence: Presence }) {
  const { t } = useTranslation()
  const shown = presence.people.slice(0, SHOWN_PEOPLE)
  const more = presence.people.length - shown.length
  if (!presence.people.length && !presence.ownWindows) return null
  return (
    <div className="flex min-w-0 items-center gap-2.5" data-testid="presence">
      {(shown.length > 0 || more > 0) && (
        <span className="flex shrink-0">
          {shown.map((person, index) => (
            <span
              key={person.accountId}
              title={person.name}
              data-testid="presence-person"
              className={'flex h-[30px] w-[30px] items-center justify-center rounded-full border-2 bg-ink-800 text-xs font-semibold text-mist-100 ' + (index ? '-ml-2' : '')}
              style={{ borderColor: person.color }}
            >
              {person.initial}
            </span>
          ))}
          {more > 0 && (
            <span data-testid="presence-more" className="-ml-2 flex h-[30px] min-w-[30px] items-center justify-center rounded-full border-2 border-ink-600 bg-ink-800 px-1 text-xs font-semibold text-mist-200">
              +{more}
            </span>
          )}
        </span>
      )}
      {presence.people.length > 0 && <span className="min-w-0 truncate text-[13px] text-mist-300">{presenceSentence(presence, t)}</span>}
      {presence.ownWindows > 0 && (
        <span data-testid="presence-own" className="shrink-0 rounded-md border px-2 py-0.5 text-xs text-mist-200" style={{ borderColor: OWN_COLOR }}>
          {t('presence.otherWindow')}
        </span>
      )}
    </div>
  )
}

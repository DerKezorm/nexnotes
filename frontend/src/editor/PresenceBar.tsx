/**
 * Who else is in the note, at the top (NOTES-12 AC-5): their initials in their colours, "Anna und Lena sind auch
 * hier", four initials and "+n" for more (EC-6), and one's own other windows as "du, anderes Fenster" (EC-8).
 */
import { useTranslation } from 'react-i18next'

import { Avatar } from '../components/Avatar'
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
            <span key={person.accountId} title={person.name} data-testid="presence-person" className={'flex rounded-full ' + (index ? '-ml-2' : '')}>
              {/* The picture where the server shows it, with a border in the person's color; else the initial. */}
              <Avatar accountId={person.accountId} name={person.name} stamp={person.avatar} size={30} ring={person.color} />
            </span>
          ))}
          {more > 0 && (
            <span data-testid="presence-more" className="-ml-2 flex h-[30px] min-w-[30px] items-center justify-center rounded-full border-2 border-ink-600 bg-ink-800 px-1 text-xs font-semibold text-mist-200">
              +{more}
            </span>
          )}
        </span>
      )}
      {/* The sentence where the head of the note has room (a container query on it); the pictures and initials always
          stay. */}
      {presence.people.length > 0 && <span className="hidden max-w-[16rem] min-w-0 truncate text-[13px] text-mist-300 @[52rem]:inline" data-testid="presence-sentence">{presenceSentence(presence, t)}</span>}
      {presence.ownWindows > 0 && (
        <span data-testid="presence-own" className="shrink-0 rounded-md border px-2 py-0.5 text-xs text-mist-200" style={{ borderColor: OWN_COLOR }}>
          {t('presence.otherWindow')}
        </span>
      )}
    </div>
  )
}

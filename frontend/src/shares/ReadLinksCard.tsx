/** "Mein Konto": every read link of the member with its note and last day, each to revoke (NOTES-13 AC-13). */
import { Link2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

import { Problem } from '../components/Field'
import { problemText } from '../lib/errors'
import { day } from '../lib/format'
import { noteHref } from '../notes/newNote'
import { Card } from '../pages/settings/ui'
import { sharesApi, type ReadLink } from './api'

export function ReadLinksCard() {
  const { t, i18n } = useTranslation()
  const [links, setLinks] = useState<ReadLink[] | null>(null)
  const [problem, setProblem] = useState('')
  const load = () => sharesApi.links().then(setLinks, (error) => setProblem(problemText(error)))
  useEffect(() => {
    void load()
  }, [])

  const revoke = async (link: ReadLink) => {
    setProblem('')
    try {
      await sharesApi.revokeLink(link.id)
      await load()
    } catch (error) {
      setProblem(problemText(error))
    }
  }

  return (
    <Card id="read-links" icon={Link2} title={t('shares.links.title')} text={t('shares.links.text')}>
      <Problem text={problem} />
      {links && links.length === 0 && <p className="text-sm text-mist-500">{t('shares.links.none')}</p>}
      {links && links.length > 0 && (
        <ul className="flex flex-col" data-testid="read-links">
          {links.map((link) => (
            <li key={link.id} className="flex flex-wrap items-center gap-3 border-b border-ink-800 py-2.5 last:border-0" data-testid="read-link">
              {link.note_gone ? (
                <span className="min-w-0 flex-1 truncate text-sm text-mist-400">{link.title || t('notes.untitled')}</span>
              ) : (
                <Link to={noteHref(link.note_id)} className="min-w-0 flex-1 truncate text-sm hover:text-accent-400">
                  {link.title || t('notes.untitled')}
                </Link>
              )}
              <span className={'text-xs ' + (link.expired ? 'text-warn-500' : 'text-mist-500')}>
                {link.expired
                  ? t('shares.links.expired', { date: day(`${link.expires_on}T12:00:00`, i18n.language) })
                  : t('shares.link.untilText', { date: day(`${link.expires_on}T12:00:00`, i18n.language) })}
              </span>
              <button type="button" className="text-[13px] text-bad-500 hover:underline" onClick={() => void revoke(link)} data-testid="read-link-revoke">
                {t('shares.link.revoke')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

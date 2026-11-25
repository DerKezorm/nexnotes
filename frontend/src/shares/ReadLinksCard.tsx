/** "Mein Konto": every read link of the member with its note and last day, each to revoke (NOTES-13 AC-13). */
import { FileText, Link2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

import { problemText } from '../lib/errors'
import { day } from '../lib/format'
import { noteHref } from '../notes/newNote'
import { Box, Button, Card, Notice, Row, Rows } from '../vendor/nexui'
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
    <Card id="read-links" icon={Link2} title={t('shares.links.title')} subtitle={t('shares.links.text')}>
      {problem && <Notice tone="danger">{problem}</Notice>}
      {links && links.length === 0 && <p className="m-0 text-sm text-[var(--nexui-text-muted)]">{t('shares.links.none')}</p>}
      {links && links.length > 0 && (
        <Box title={t('shares.links.title')}>
          <Rows testId="read-links">
            {links.map((link) => (
              <Row
                key={link.id}
                testId="read-link"
                icon={FileText}
                name={
                  link.note_gone ? (
                    <span className="text-[var(--nexui-text-muted)]">{link.title || t('notes.untitled')}</span>
                  ) : (
                    <Link to={noteHref(link.note_id)} className="hover:underline">
                      {link.title || t('notes.untitled')}
                    </Link>
                  )
                }
                detail={
                  <span className={link.expired ? 'text-[var(--nexui-warn)]' : undefined}>
                    {link.expired
                      ? t('shares.links.expired', { date: day(`${link.expires_on}T12:00:00`, i18n.language) })
                      : t('shares.link.untilText', { date: day(`${link.expires_on}T12:00:00`, i18n.language) })}
                  </span>
                }
                action={
                  <Button kind="danger" icon="Unlink" testId="read-link-revoke" onClick={() => void revoke(link)}>
                    {t('shares.link.revoke')}
                  </Button>
                }
              />
            ))}
          </Rows>
        </Box>
      )}
    </Card>
  )
}

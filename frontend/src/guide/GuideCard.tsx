/**
 * Settings › Appearance: the guide (NOTES-26). Every account gets the folder "Anleitung" ("Guide") once; this card
 * makes it again as a fresh folder next to what is there ("Anleitung (2)" when the name is taken), in the language
 * of the page. The account's own changes stay as they are; nothing is updated by itself.
 */
import { BookOpen } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

import { api } from '../api/client'
import { Done, Problem } from '../components/Field'
import { refreshFolders } from '../folders/store'
import { problemText } from '../lib/errors'
import { Card } from '../pages/settings/ui'

type Made = { id: string; name: string }

function makeGuide(language: string): Promise<Made> {
  return api<Made>('/api/guide', { method: 'POST', body: { language: language.startsWith('de') ? 'de' : 'en' } })
}

export function GuideCard() {
  const { t, i18n } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [made, setMade] = useState<Made | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  const make = async () => {
    setBusy(true)
    setProblem(null)
    setMade(null)
    try {
      const folder = await makeGuide(i18n.language)
      setMade(folder)
      await refreshFolders()
    } catch (error) {
      setProblem(problemText(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card id="guide" icon={BookOpen} title={t('guide.title')} text={t('guide.text')}>
      <div aria-live="polite">
        <Problem text={problem} />
        <Done
          testId="guide-made"
          text={
            made && (
              <>
                {t('guide.made', { name: made.name })}{' '}
                <Link to={`/folder/${made.id}`} className="font-medium underline">
                  {t('guide.open')}
                </Link>
              </>
            )
          }
        />
      </div>
      <button type="button" className="nn-btn nn-btn-ghost" disabled={busy} onClick={() => void make()} data-testid="guide-make">
        {busy ? t('guide.making') : t('guide.make')}
      </button>
    </Card>
  )
}

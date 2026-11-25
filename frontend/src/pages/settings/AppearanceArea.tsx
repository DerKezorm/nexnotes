/**
 * My account › Appearance (plan "Einstellungen", "Darstellung"): first the card "Aussehen" of every app (konten's
 * `AppearanceCard`: light, dark, as the system, at the account), then nexnotes' own cards: the paper of new notes (NOTES-3 AC-17), how the
 * lists of notes look (NOTES-6), and the guide (NOTES-26).
 */
import { FileText, LayoutList } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { authApi } from '../../api/client'
import { paperOf } from '../../editor/paper'
import { PaperPicker } from '../../editor/PaperPicker'
import { showNotice } from '../../folders/notice'
import { GuideCard } from '../../guide/GuideCard'
import { problemText } from '../../lib/errors'
import { applyMode } from '../../lib/theme'
import { LookSettings } from '../../notes/list/LookSettings'
import { useAuth } from '../../state/auth'
import { AppearanceCard } from '../../vendor/nexkonten/AccountCards'
import { themeOf } from '../../vendor/nexkonten/konten'
import { Card } from '../../vendor/nexui'
import { useAction } from './actions'
import { Outcome } from './Outcome'

/**
 * Light, dark or as the system, at the account on every device (konten 1.1.0, ``AppearanceCard``): shown at once, saved
 * at the account (`PUT /api/me/theme`); a refusal puts the choice back.
 */
function LookCard() {
  const { me, setMe } = useAuth()
  if (!me) return null
  const before = me.theme ?? ''
  return (
    <AppearanceCard
      theme={me.theme}
      onChange={(value) => {
        setMe({ ...me, theme: value })
        authApi.theme(value).then(setMe, (error: unknown) => {
          setMe({ ...me, theme: before })
          applyMode(themeOf(before))
          showNotice({ text: problemText(error) })
        })
      }}
    />
  )
}

export function AppearanceArea() {
  const { t } = useTranslation()
  const { me, setMe } = useAuth()
  const paper = useAction()
  if (!me) return null
  return (
    <>
      <LookCard />
      <Card id="paper" icon={FileText} title={t('me.looks.paper')} subtitle={t('me.looks.paperHint')}>
        <PaperPicker value={paperOf(me.paper)} onChange={(chosen) => void paper.run(async () => setMe(await authApi.paper(chosen)))} />
        <Outcome problem={paper.problem} />
      </Card>
      <Card id="lists" icon={LayoutList} title={t('me.lists.title')}>
        <LookSettings />
      </Card>
      <GuideCard />
    </>
  )
}

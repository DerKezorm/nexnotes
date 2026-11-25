/**
 * My account › Appearance (plan "Einstellungen", "Darstellung"): first the card "Aussehen" of every app (the kit's
 * `ThemeSegment`: light, dark, as the system), then nexnotes' own cards: the paper of new notes (NOTES-3 AC-17), how the
 * lists of notes look (NOTES-6), and the guide (NOTES-26).
 */
import { FileText, LayoutList } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { authApi } from '../../api/client'
import { paperOf } from '../../editor/paper'
import { PaperPicker } from '../../editor/PaperPicker'
import { GuideCard } from '../../guide/GuideCard'
import { applyMode, storedMode, type Mode } from '../../lib/theme'
import { LookSettings } from '../../notes/list/LookSettings'
import { useAuth } from '../../state/auth'
import { Card, ThemeSegment, useNexuiTexts } from '../../vendor/nexui'
import { useAction } from './actions'
import { Outcome } from './Outcome'

/**
 * Light, dark or as the system.
 *
 * TODO konten 1.1.0: the plan keeps the choice in the account (profile field `theme`, on every device; the server takes
 * a browser's value over the first time). Until the account module brings it, the choice stays in this browser, as
 * before (`lib/theme`), although the kit's hint already speaks of every device.
 */
function LookCard() {
  const kit = useNexuiTexts()
  const [mode, setMode] = useState<Mode>(storedMode())
  return (
    <Card id="look" icon="Palette" title={kit.appearance}>
      <ThemeSegment
        value={mode}
        onChange={(value) => {
          applyMode(value)
          setMode(value)
        }}
        testId="theme"
      />
    </Card>
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

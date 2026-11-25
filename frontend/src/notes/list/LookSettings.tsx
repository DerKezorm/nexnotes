/**
 * Einstellungen › Darstellung, the card "Notizlisten": how every list of notes looks (list, cards, compact, tiles, each
 * with its sign as in the menu "Ansicht", a `Segment` of the ui kit) and which hints rows carry: checklists,
 * attachments, tags, each with its own tick (`CheckboxRow`; NOTES-6, NOTESIOS-6 AC-1). The same choice as in that menu
 * (`look.ts`, `PUT /api/me/list-look`): changed here, every list shows it at once, and the other way round.
 */
import { useTranslation } from 'react-i18next'

import { CheckboxRow, Segment } from '../../vendor/nexui'
import { LIST_STYLES, type ListStyle } from './api'
import { HINT_KINDS, saveListLook, useListLook } from './look'
import { STYLE_ICONS } from './styleIcons'

export function LookSettings() {
  const { t } = useTranslation()
  const look = useListLook()
  return (
    <>
      <Segment<ListStyle>
        label={t('me.lists.style')}
        hints={[t('me.lists.styleHint')]}
        value={look.style}
        onChange={(style) => void saveListLook({ style })}
        options={LIST_STYLES.map((style) => ({ value: style, label: t(`noteList.style.${style}`), icon: STYLE_ICONS[style], testId: `settings-list-style-${style}` }))}
        testId="settings-list-style"
      />
      <div role="group" aria-labelledby="list-hints-label" className="flex flex-col gap-2" data-testid="settings-list-hints">
        <span className="text-sm font-medium" id="list-hints-label">
          {t('me.lists.hints')}
        </span>
        {HINT_KINDS.map((kind) => (
          <CheckboxRow
            key={kind}
            label={t(`noteList.hints.kind.${kind}`)}
            checked={look.hints[kind]}
            testId={`settings-list-hints-${kind}`}
            onChange={(on) => void saveListLook({ hints: { [kind]: on } })}
          />
        ))}
      </div>
    </>
  )
}

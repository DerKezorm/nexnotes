/**
 * Einstellungen › Darstellung, the card "Notizlisten": how every list of notes looks (list, cards, compact, tiles, each
 * with its sign as in the menu "Ansicht") and whether rows carry their hints. The same choice as in that menu
 * (`look.ts`, `PUT /api/me/list-look`): changed here, every list shows it at once, and the other way round.
 */
import { useTranslation } from 'react-i18next'

import { LIST_STYLES } from './api'
import { saveListLook, useListLook } from './look'
import { STYLE_ICONS } from './styleIcons'

export function LookSettings() {
  const { t } = useTranslation()
  const look = useListLook()
  return (
    <>
      <div className="text-sm">
        <span className="font-medium" id="list-look-label">
          {t('me.lists.style')}
        </span>{' '}
        <span className="text-xs text-mist-500">{t('me.lists.styleHint')}</span>
        <div role="radiogroup" aria-labelledby="list-look-label" className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="settings-list-style">
          {LIST_STYLES.map((style) => {
            const Icon = STYLE_ICONS[style]
            const on = look.style === style
            return (
              <button
                key={style}
                type="button"
                role="radio"
                aria-checked={on}
                data-testid={`settings-list-style-${style}`}
                onClick={() => {
                  if (!on) void saveListLook({ style })
                }}
                className={
                  'flex flex-col items-center gap-1.5 rounded-[10px] border px-2 py-3 text-[13px] ' +
                  (on ? 'border-accent-500 bg-accent-wash font-semibold text-accent-400' : 'border-ink-700 text-mist-300 hover:border-ink-600 hover:text-mist-100')
                }
              >
                <Icon aria-hidden className="h-6 w-6" strokeWidth={1.7} />
                {t(`noteList.style.${style}`)}
              </button>
            )
          })}
        </div>
      </div>
      <div className="flex items-center gap-3 text-sm">
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="font-medium" id="list-hints-label">
            {t('me.lists.hints')}
          </span>
          <span className="text-xs text-mist-500">{t('noteList.hints.text')}</span>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={look.hints}
          aria-labelledby="list-hints-label"
          data-testid="settings-list-hints"
          onClick={() => void saveListLook({ hints: !look.hints })}
          className={'flex h-[22px] w-[38px] shrink-0 items-center rounded-full p-0.5 ' + (look.hints ? 'justify-end bg-accent-500' : 'justify-start bg-ink-600')}
        >
          <span className={'h-[18px] w-[18px] rounded-full ' + (look.hints ? 'bg-on-accent' : 'bg-mist-300')} />
        </button>
      </div>
    </>
  )
}

/**
 * About nexnotes, the ui kit's `AboutPage` (plan "Einstellungen", "Über"): version, licence, where it comes from,
 * whether a newer one is out, and what it is built with. An area of the settings (`/settings/about`, last in the
 * navigation, for every account); the old address `/about` leads there.
 *
 * The state of the check comes from the shared module updates (`vendor/nexupdates`, `useUpdates`). Only the operator
 * sees the card "Aktualisierungen", switches the daily check and asks now (U2, U15): the question goes out for the
 * whole installation. A member sees its own version and nothing of the check. The card says what goes out. The row
 * "Was ist neu" opens the newest text of the shared module wasneu (`vendor/nexwasneu`), "Frühere Versionen" all.
 */
import { useTranslation } from 'react-i18next'

import { tabFetch } from '../../lib/tabFetch'
import { formatMoment } from '../../vendor/nexui'
import { useAuth } from '../../state/auth'
import { AboutPage, Notice, type BuiltWith } from '../../vendor/nexui'
import { useUpdates, useUpdatesTexts, whatGoesOut } from '../../vendor/nexupdates/updates'
import { useAboutWhatsNew } from '../../vendor/nexwasneu'

const PARTS: BuiltWith[] = [
  { name: 'FastAPI', url: 'https://fastapi.tiangolo.com', licence: 'MIT' },
  { name: 'SQLAlchemy', url: 'https://www.sqlalchemy.org', licence: 'MIT' },
  { name: 'SQLite', url: 'https://sqlite.org', licence: 'Public Domain' },
  { name: 'pycrdt', url: 'https://github.com/y-crdt/pycrdt', licence: 'MIT' },
  { name: 'Pillow', url: 'https://python-pillow.org', licence: 'MIT-CMU' },
  { name: 'pillow-heif', url: 'https://github.com/bigcat88/pillow_heif', licence: 'BSD-3' },
  { name: 'React', url: 'https://react.dev', licence: 'MIT' },
  { name: 'Vite', url: 'https://vite.dev', licence: 'MIT' },
  { name: 'Tailwind CSS', url: 'https://tailwindcss.com', licence: 'MIT' },
  { name: 'Yjs', url: 'https://yjs.dev', licence: 'MIT' },
  { name: 'Lucide', url: 'https://lucide.dev', licence: 'ISC' },
  { name: 'i18next', url: 'https://www.i18next.com', licence: 'MIT' },
  { name: 'Inter', url: 'https://rsms.me/inter/', licence: 'OFL-1.1' },
  { name: 'Typst', url: 'https://typst.app', licence: 'Apache-2.0' },
  { name: 'JetBrains Mono', url: 'https://www.jetbrains.com/lp/mono/', licence: 'OFL-1.1' },
  { name: 'Noto Emoji', url: 'https://fonts.google.com/noto/specimen/Noto+Emoji', licence: 'OFL-1.1' },
]

export function AboutArea() {
  const { t, i18n } = useTranslation()
  const { me } = useAuth()
  const operator = me?.role === 'operator'
  const texts = useUpdatesTexts(i18n.language)
  const news = useAboutWhatsNew({ app: 'nexnotes', logo: '/logo.svg', fetcher: tabFetch, language: i18n.language })
  const state = useUpdates({ fetcher: tabFetch, operator, when: (iso) => formatMoment(iso, i18n.language), language: i18n.language })

  if (!state.about) return state.problem ? <Notice tone="danger">{state.problem}</Notice> : null
  return (
    <>
      <AboutPage
        app="nexnotes"
        logo="/logo.svg"
        tagline={t('about.subtitle')}
        version={state.about.version}
        licence={{ name: state.about.license, href: 'https://www.gnu.org/licenses/agpl-3.0.html' }}
        source={state.about.repo_url}
        releases={state.about.releases_url}
        project={state.about.project_url || null}
        updates={state.updates}
        showUpdates={state.showUpdates}
        operator={operator}
        onDaily={state.onDaily}
        onCheck={state.onCheck}
        checking={state.checking}
        builtWith={PARTS}
        problem={state.problem}
        texts={{ updatesWhatGoesOut: whatGoesOut(texts, 'nexnotes') }}
        {...news.about}
      />
      {news.window}
    </>
  )
}

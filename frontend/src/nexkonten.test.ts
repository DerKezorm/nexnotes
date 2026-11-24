/**
 * Every text of the konten module is in the app, in German and English, through the app's own i18n, and the screens
 * show the module's fields in the module's order. Copied once by the module's `tools/sync.py` to
 * `frontend/src/nexkonten.test.ts`; then the app's file. Fill in the places marked APP.
 *
 * The module's own tests check the wording files word for word against the blueprint; this test checks that the
 * app really loads them (merged into its resources, `{{app}}`, `{{setupTokenEnv}}` and `{{minimum}}` filled in
 * through kontenVariables) and that nothing in the app overrides them.
 */
import { describe, expect, it } from 'vitest'

import { kontenVariables, SCREENS, screenFields, suggestUsername } from './vendor/nexkonten/konten'
import de from './vendor/nexkonten/konten.de.json'
import en from './vendor/nexkonten/konten.en.json'
// APP: the app's i18n instance after its set-up (with the module's files merged into the resources and
// interpolation.defaultVariables: kontenVariables(APP_NAME)).
import i18n from './i18n'

// APP: the app's name as its container is called.
const APP_NAME = 'nexnotes'
// APP: the fields each screen of the app shows, top to bottom, by the module's field names (screenFields).
const APP_SCREENS: Partial<Record<keyof typeof SCREENS, readonly string[]>> = {
  setup: SCREENS.setup,
  invite: SCREENS.invite,
  login: SCREENS.login,
  forgot: SCREENS.forgot,
  reset: SCREENS.reset,
  profile: SCREENS.profile,
}

type Tree = { [key: string]: string | Tree }

function leaves(tree: Tree, prefix = ''): [string, string][] {
  return Object.entries(tree).flatMap(([name, value]) => {
    const key = prefix ? `${prefix}.${name}` : name
    return typeof value === 'string' ? [[key, value] as [string, string]] : leaves(value, key)
  })
}

const values = { username: 'kim', email: 'kim@example.com' }
const fill: Record<string, string | number> = { ...kontenVariables(APP_NAME), ...values }

describe('the konten texts', () => {
  for (const [language, tree] of [['de', de], ['en', en]] as const) {
    it(`are all in the app in ${language}, word for word`, async () => {
      await i18n.changeLanguage(language)
      for (const [key, text] of leaves(tree as Tree)) {
        // A plural form is asked for by its key without the ending and a count that picks it (as nexoidc.wording).
        const plural = /_(one|other)$/.exec(key)
        const count = plural ? (plural[1] === 'one' ? 1 : 2) : undefined
        const asked = plural ? key.slice(0, -plural[0].length) : key
        const filled = count === undefined ? fill : { ...fill, count }
        const expected = text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(filled[name] ?? ''))
        expect(i18n.t(asked, count === undefined ? values : { ...values, count }), key).toBe(expected)
      }
    })
  }
})

describe('the konten screens', () => {
  it('show the fields of the module in its order', () => {
    for (const [screen, fields] of Object.entries(APP_SCREENS)) {
      expect(fields, screen).toEqual(screenFields(screen as keyof typeof SCREENS).map((entry) => entry.field))
    }
  })

  it('suggest the username the server would', () => {
    expect(suggestUsername('Max Müller')).toBe('max-mueller')
  })
})

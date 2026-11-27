/**
 * The places the texts name are the places of the settings as they are now (plan "Einstellungen", E39): a path
 * "Mein Konto › …" or "Server › …" goes on with an area of that group, in the words of the navigation. A text of
 * nexnotes about nextasks names nextasks' places, which carry the same words (all apps of the plan share them). The
 * word for a program's access is "API-Schlüssel" ("API key"), never "API-Token"; and no text points the old way
 * ("unter Einstellungen, Server").
 */
import { describe, expect, it } from 'vitest'

import { NEXUI_TEXTS } from '../vendor/nexui'
import { VERBINDEN_TEXTS } from '../vendor/nexverbinden'
import de from './de.json'
import en from './en.json'

type Tree = { [key: string]: string | Tree }

function texts(tree: Tree, prefix = ''): [string, string][] {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === 'string' ? [[prefix + key, value] as [string, string]] : texts(value, `${prefix}${key}.`),
  )
}

const ACCOUNT = ['profile', 'security', 'appearance', 'notifications', 'connections'] as const
const SERVER = ['general', 'server-connections', 'sign-in', 'mail', 'storage', 'accounts', 'log', 'ai-provider'] as const

const LANGUAGES = [
  { name: 'de', tree: de as unknown as Tree, kit: NEXUI_TEXTS.de, own: de.settings.areas.ocr.title },
  { name: 'en', tree: en as unknown as Tree, kit: NEXUI_TEXTS.en, own: en.settings.areas.ocr.title },
]

describe('the places the texts name', () => {
  for (const { name, tree, kit, own } of LANGUAGES) {
    const groups: Record<string, string[]> = {
      [kit.groupAccount]: ACCOUNT.map((slug) => kit.areas[slug].title),
      [kit.groupServer]: [...SERVER.map((slug) => kit.areas[slug].title), own],
    }

    it(`are areas of the settings as the navigation calls them (${name})`, () => {
      const wrong: string[] = []
      let paths = 0
      for (const [key, text] of texts(tree)) {
        for (const [group, areas] of Object.entries(groups)) {
          for (const found of text.matchAll(new RegExp(`${group} › `, 'g'))) {
            paths += 1
            const rest = text.slice((found.index ?? 0) + found[0].length)
            if (!areas.some((area) => rest.startsWith(area))) wrong.push(`${key}: ${text}`)
          }
        }
      }
      expect(wrong).toEqual([])
      // The texts that lead somewhere: nextasks, the MCP consent, the reset notice, the errors about the address.
      expect(paths).toBeGreaterThanOrEqual(8)
    })

    it(`say API key and point no old way (${name})`, () => {
      const old = texts(tree).filter(([, text]) =>
        /API-Token|API tokens?\b|unter Einstellungen, |under Settings, |Speicher und Sicherungen|„Mein Konto“|“My account”/.test(text),
      )
      expect(old.map(([key, text]) => `${key}: ${text}`)).toEqual([])
    })
  }

  for (const { name, tree, kit, own } of LANGUAGES) {
    const areas = [...ACCOUNT, ...SERVER].map((slug) => kit.areas[slug].title).concat(own)
    const words = [kit.groupAccount, kit.groupServer, kit.settings, ...areas].map((word) => word.replace(/[()]/g, '\\$&')).join('|')

    it(`write a place group › area, with no comma, arrow or "card" as a separator (E46, ${name})`, () => {
      const wrong: string[] = []
      for (const [key, text] of texts(tree)) {
        if (new RegExp(`\\b(${words})\\s*(,|→|->)\\s*(${words})\\b`).test(text)) wrong.push(`${key}: ${text}`)
        if (new RegExp(`(Karte|card) [„“"](${words})`).test(text)) wrong.push(`${key}: ${text}`)
        // An area at the start of a path needs its group before it.
        for (const found of text.matchAll(new RegExp(`(^|[^›] )(${areas.join('|').replace(/[()]/g, '\\$&')}) › `, 'g'))) {
          const at = (found.index ?? 0) + found[1]!.length
          const before = text.slice(0, at)
          const grouped = before.endsWith(`${kit.groupAccount} › `) || before.endsWith(`${kit.groupServer} › `)
          if (!grouped) wrong.push(`${key}: ${text}`)
        }
      }
      expect(wrong).toEqual([])
    })
  }

  it('lead to the places of nextasks and of the server in the same words', () => {
    expect(de.nextasks.section.how).toContain('in nextasks unter Mein Konto › Verbindungen › API-Schlüssel')
    expect(en.nextasks.section.how).toContain('in nextasks, create a key that reads and writes under My account › Connections › API keys')
    expect(de.errors.nextasks_not_connected).toContain('Mein Konto › Verbindungen › nextasks')
    expect(de.errors.public_url_missing).toContain('Server › Anmeldung')
    // verbinden 0.1.8: the own network has one place, the module's card "Andere nex-Apps", since E67 under Server ›
    // Verbindungen.
    expect(de.nextasks.section.localOff).toContain(`Server › Verbindungen › ${VERBINDEN_TEXTS.de.operator.title}`)
    expect(en.nextasks.section.localOff).toContain(`Server › Connections › ${VERBINDEN_TEXTS.en.operator.title}`)
    expect(de.errors.nextasks_address_local).toContain(`Server › Verbindungen › ${VERBINDEN_TEXTS.de.operator.title}`)
    expect(de.nextasks.section.localOff).not.toContain(de.server.features)
  })
})

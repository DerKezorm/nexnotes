/**
 * The cards of an area stand 24 px apart, as the kit's `SettingsPage` lays them (`gap-6`, ui README): an area that
 * nests its cards in a list of its own (Profil and Sicherheit in `AccountTab`, Konten in `AccountsTab`) keeps the same
 * 24 px (`space-y-6`), never 20 (`space-y-5`).
 */
type Files = { readFileSync: (file: string, encoding: string) => string; readdirSync: (dir: string) => string[] }
const fsName = 'node:fs'
const files = (await import(/* @vite-ignore */ fsName)) as Files

const area = (name: string) => files.readFileSync(`src/pages/settings/${name}`, 'utf-8')

describe('the space between the cards of an area', () => {
  it('is 24 px in the areas that list their cards themselves', () => {
    for (const name of ['AccountTab.tsx', 'AccountsTab.tsx']) {
      const source = area(name)
      // The outermost element an area returns holds its cards.
      const outer = /return \(\s*<div className="([^"]*)"/.exec(source.slice(source.lastIndexOf('export function')))
      expect(outer?.[1].split(' '), name).toContain('space-y-6')
    }
  })

  it('is never 20 px in the settings', () => {
    const offenders = files
      .readdirSync('src/pages/settings')
      .filter((name) => name.endsWith('.tsx') && !name.includes('.test.'))
      .filter((name) => /\bspace-y-5\b|\bgap-5\b/.test(area(name)))
    expect(offenders).toEqual([])
  })
})

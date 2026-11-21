/** NOTES-3 AC-17: the four papers drawn from the sheet's CSS, light and dark apart, quiet gray, nothing in print. */
import { paperOf, PAPERS } from './paper'

type Files = { readFileSync: (file: string, encoding: string) => string }
const fsName = 'node:fs'
const css = ((await import(/* @vite-ignore */ fsName)) as Files).readFileSync('src/editor/editor.css', 'utf-8')

describe('NOTES-3 AC-17 the papers', () => {
  it('NOTES-3 AC-17 blank, lined, grid and dots, anything else is blank', () => {
    expect(PAPERS).toEqual(['blank', 'lined', 'grid', 'dots'])
    expect(paperOf('grid')).toBe('grid')
    expect(paperOf('wavy')).toBe('blank')
    expect(paperOf(undefined)).toBe('blank')
  })

  it('NOTES-3 AC-17 each pattern is a background of the sheet, tuned apart for light and dark, never honey, not printed', () => {
    for (const paper of ['lined', 'grid', 'dots']) expect(css).toMatch(new RegExp(`\\.nn-paper\\[data-paper='${paper}'\\][^{]*\\{[^}]*background-image`))
    expect(css).toMatch(/\.nn-paper, \.nn-paper-preview \{[^}]*--nn-paper-ink: rgb\(242 242 245/)
    expect(css).toMatch(/:root\[data-theme='light'\] \.nn-paper,[^{]*\{[^}]*--nn-paper-ink: rgb\(20 20 26/)
    expect(css).toMatch(/background-attachment: local/)
    expect(css).toMatch(/background-size: 24px 24px/)
    expect(css).toMatch(/--nn-paper-line: 24\.75px/)
    expect(css).toMatch(/@media print \{\s*\.nn-paper \{ background: none !important; \}/)
    const paperRules = css.slice(css.indexOf('/* ---- Paper'))
    expect(paperRules).not.toMatch(/accent|f2c14e|242 193 78/)
  })
})

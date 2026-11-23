// A locked button stays grey in every state, in light and dark: its hover never paints it. `.nn-btn:disabled` and
// `.nn-btn-accent:hover` weigh the same and the variant comes later, so a bare `hover:` in a variant would win over the
// locked look (a locked accent button turned honey under the pointer, its text grey). Every hover of a button class,
// and every hover added to such a button in the components, is therefore `not-disabled:hover:` (not `enabled:`: the
// classes also dress links). Read from the sources.
import { describe, expect, it } from 'vitest'

type Files = {
  readFileSync: (file: string, encoding: string) => string
  readdirSync: (dir: string, options: { recursive: true }) => string[]
}
const fsName = 'node:fs'
const files = (await import(/* @vite-ignore */ fsName)) as Files
const css = files.readFileSync('src/styles/index.css', 'utf-8').replace(/\r\n/g, '\n')

/** The utilities a rule of the components layer applies. */
function applied(selector: string): string[] {
  const match = new RegExp(`\\n  ${selector.replace('.', '\\.')} \\{\\s*@apply ([^;]+);`).exec(css)
  expect(match, selector).not.toBeNull()
  return match![1].split(/\s+/)
}

/** The utilities that act on hover but not only while the button is free. */
const bareHover = (classes: string[]) => classes.filter((name) => /(^|:)hover:/.test(name) && !name.startsWith('not-disabled:hover:'))

const BUTTONS = ['.nn-btn', '.nn-btn-accent', '.nn-btn-ghost', '.nn-btn-danger', '.nn-btn-quiet', '.nn-menu-item']

describe('a locked button', () => {
  it('has a grey look of its own', () => {
    expect(applied('.nn-btn')).toEqual(expect.arrayContaining(['disabled:bg-ink-800', 'disabled:text-mist-600', 'disabled:cursor-not-allowed']))
  })

  it('is not painted by the hover of any button class', () => {
    for (const selector of BUTTONS) expect(bareHover(applied(selector)), selector).toEqual([])
  })

  it('is not painted by a hover a component adds to a button', () => {
    const sources = files
      .readdirSync('src', { recursive: true })
      .map((name) => name.replace(/\\/g, '/'))
      .filter((name) => name.endsWith('.tsx') && !name.includes('.test.'))
    const found = new Set<string>()
    for (const name of sources) {
      const text = files.readFileSync(`src/${name}`, 'utf-8')
      // Where a button class stands, with what is added to it: its line (`const look = 'nn-btn-ghost …'`) and the whole
      // `className={…}` round it, which may run over several lines.
      const parts = text.split('\n')
      for (let at = text.indexOf('className={'); at !== -1; at = text.indexOf('className={', at + 1)) {
        let depth = 0
        let end = at + 'className='.length
        for (; end < text.length; end++) {
          if (text[end] === '{') depth++
          else if (text[end] === '}' && --depth === 0) break
        }
        parts.push(text.slice(at, end + 1))
      }
      for (const part of parts.filter((part) => /\bnn-(?:btn|menu-item)\b/.test(part))) {
        for (const utility of bareHover(part.split(/[\s'"`{}()+]+/).filter(Boolean))) found.add(`${name}: ${utility}`)
      }
    }
    expect([...found]).toEqual([])
  })
})

/**
 * NOTES-23 AC-5: what was shared becomes the parts of a note. The link and the text apart, the suggested title, the
 * Markdown in the server's format (text escaped as the server escapes it), where it came from, and what the worker
 * hands over.
 */
import { escapeText, shareMarkdown, shareOrigin, splitShared, suggestShareTitle } from './compose'
import { followAccount, forgetAccount } from '../../state/account'
import { asShared, doneShared, forgetTaken, takeShared } from './take'

const none: File[] = []

describe('NOTES-23 AC-5 what was shared becomes a note', () => {
  it('NOTES-23 AC-5 the link apart from the text, wherever the app put it', () => {
    expect(splitShared({ url: 'https://a.example/x', text: '' })).toEqual({ link: 'https://a.example/x', text: '' })
    expect(splitShared({ url: 'https://a.example/x', text: 'https://a.example/x' })).toEqual({ link: 'https://a.example/x', text: '' })
    expect(splitShared({ url: 'https://a.example/x', text: 'Schau mal https://a.example/x' })).toEqual({ link: 'https://a.example/x', text: 'Schau mal' })
    expect(splitShared({ url: '', text: 'https://b.example/y?q=1' })).toEqual({ link: 'https://b.example/y?q=1', text: '' })
    expect(splitShared({ url: '', text: 'Kompost anlegen\nhttps://c.example/k' })).toEqual({ link: 'https://c.example/k', text: 'Kompost anlegen' })
    expect(splitShared({ url: '', text: 'Milch kaufen' })).toEqual({ link: '', text: 'Milch kaufen' })
    // A link in the middle stays text; only a web address counts.
    expect(splitShared({ url: '', text: 'siehe https://d.example und dann' })).toEqual({ link: '', text: 'siehe https://d.example und dann' })
    expect(splitShared({ url: 'javascript:alert(1)', text: 'x' })).toEqual({ link: '', text: 'x' })
  })

  it('NOTES-23 AC-5 the suggested title: the shared one, the first words, the file, the site', () => {
    expect(suggestShareTitle({ title: '  Kompost richtig anlegen ', files: none }, 'https://g.example/k', '')).toBe('Kompost richtig anlegen')
    // A title that is only the link says nothing.
    expect(suggestShareTitle({ title: 'https://g.example/k', files: none }, 'https://g.example/k', '')).toBe('g.example')
    expect(suggestShareTitle({ title: '', files: none }, '', 'Milch, Eier und Butter')).toBe('Milch')
    expect(suggestShareTitle({ title: '', files: [new File(['x'], 'Rechnung März.pdf')] }, '', '')).toBe('Rechnung März')
    expect(suggestShareTitle({ title: '', files: none }, 'https://www.garten.example/a', '')).toBe('www.garten.example')
    expect(suggestShareTitle({ title: '', files: none }, '', '')).toBe('')
    expect(Array.from(suggestShareTitle({ title: 'x'.repeat(300), files: none }, '', '')).length).toBe(120)
  })

  it('NOTES-23 AC-5 text stays text: the marks the server escapes', () => {
    expect(escapeText('# Titel', true)).toBe('\\# Titel')
    expect(escapeText('#einkauf', true)).toBe('#einkauf')
    expect(escapeText('- Punkt', true)).toBe('\\- Punkt')
    expect(escapeText('1. Punkt', true)).toBe('1\\. Punkt')
    expect(escapeText('> Zitat', true)).toBe('\\> Zitat')
    expect(escapeText('*fett* _schräg_ `code` [a](b) ~x~ a|b', false)).toBe('\\*fett\\* \\_schräg\\_ \\`code\\` \\[a\\](b) \\~x\\~ a\\|b')
    expect(escapeText('Tom &amp; Jerry', false)).toBe('Tom \\&amp; Jerry')
    expect(escapeText('C:\\Daten', false)).toBe('C:\\\\Daten')
  })

  it('NOTES-23 AC-5 the Markdown: the link on a line of its own, the texts, each file as a block of its attachment', () => {
    const markdown = shareMarkdown({
      link: 'https://g.example/a_(b)',
      text: 'Erste Zeile\n\n- zweite',
      note: '  Für das Hochbeet ',
      files: [
        { id: 'A'.repeat(22), name: 'foto [1].jpg', picture: true },
        { id: 'B'.repeat(22), name: 'plan.pdf', picture: false },
      ],
    })
    expect(markdown).toBe(
      [
        '[https://g.example/a\\_(b)](https://g.example/a_\\(b\\))',
        'Erste Zeile\n\n\\- zweite',
        'Für das Hochbeet',
        `![foto \\[1\\].jpg](attachment:${'A'.repeat(22)})`,
        `[plan.pdf](attachment:${'B'.repeat(22)})`,
      ].join('\n\n'),
    )
    expect(shareMarkdown({ link: '', text: '', note: '', files: [] })).toBe('')
  })

  it('NOTES-23 AC-5 where it came from: Android, else a share', () => {
    expect(shareOrigin('Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/142.0 Mobile Safari/537.36')).toBe('share:Android')
    expect(shareOrigin('Mozilla/5.0 (X11; CrOS x86_64 16000.0.0) Chrome/142.0 Safari/537.36')).toBe('share')
  })

  it('NOTES-23 AC-5 only what the worker should send is taken from it', () => {
    const photo = new File(['x'], 'p.jpg')
    expect(asShared({ title: 'A', text: 'B', url: 'https://c.example', files: [photo, 'no', { name: 'fake', size: 3 }] })).toEqual({ title: 'A', text: 'B', url: 'https://c.example', files: [photo] })
    expect(asShared({ title: 1, text: null })).toBeNull()
    expect(asShared(null)).toBeNull()
    expect(asShared('text')).toBeNull()
    expect(asShared({ title: '', text: '', url: '', files: [] })).toBeNull()
  })
})

describe('NOTES-23 AC-5 what was shared waits in the page, never longer', () => {
  const ID = 'b'.repeat(32)
  let asked = 0
  let told: unknown[] = []

  beforeEach(() => {
    asked = 0
    told = []
    forgetTaken()
    forgetAccount()
    class Port {
      other: Port | null = null
      onmessage: ((event: { data: unknown }) => void) | null = null
      postMessage(data: unknown) {
        this.other?.onmessage?.({ data })
      }
    }
    vi.stubGlobal(
      'MessageChannel',
      class {
        port1 = new Port()
        port2 = new Port()
        constructor() {
          this.port1.other = this.port2
          this.port2.other = this.port1
        }
      },
    )
    const worker = {
      postMessage(message: { type: string; id: string }, ports?: Port[]) {
        told.push(message)
        if (message.type !== 'nexnotes-share-take') return
        asked += 1
        ports?.[0]?.postMessage(message.id === ID ? { title: 'Geteilt', text: '', url: '', files: [] } : null)
      },
    }
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { controller: worker, getRegistration: async () => ({ active: worker }) } })
  })

  afterEach(() => vi.unstubAllGlobals())

  it('NOTES-23 AC-5 taken once from the worker, then from the page; only well-formed ids are asked for', async () => {
    expect(await takeShared('../x')).toBeNull()
    expect(asked).toBe(0)
    expect((await takeShared(ID))?.title).toBe('Geteilt')
    expect((await takeShared(ID))?.title).toBe('Geteilt')
    expect(asked).toBe(1)
    doneShared(ID)
    await vi.waitFor(() => expect(told).toContainEqual({ type: 'nexnotes-share-done', id: ID }))
  })

  it('NOTES-23 AC-5 the member signing in keeps it; signing out or another account drops it', async () => {
    followAccount(null)
    await takeShared(ID)
    followAccount(5)
    await takeShared(ID)
    expect(asked).toBe(1)
    followAccount(6)
    await takeShared(ID)
    expect(asked).toBe(2)
    followAccount(null)
    await takeShared(ID)
    expect(asked).toBe(3)
  })
})

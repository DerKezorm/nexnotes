/**
 * NOTES-8 AC-9: the addresses of the workspace. The list as the path, the note beside it as `?note=`; all notes keep
 * `/notes/<id>`; an address of before (`/notes/<id>?folder=`) is that folder's list. Going to another list keeps the
 * notes open on a wider screen, so an open note without a title is not asked then.
 */
import { forgetTabs, loadAccountTabs, tabs } from '../tabs/store'
import { folderOfList, hrefIn, isListPath, keepsNotesOpen, listOf, noteOf } from './workspace'

function wide(matches: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }))
}

afterEach(() => {
  vi.unstubAllGlobals()
  forgetTabs()
  localStorage.clear()
})

describe('NOTES-8 AC-9 the workspace addresses', () => {
  it('NOTES-8 AC-9 every list is a path, the note beside it a parameter; all notes keep /notes/<id>', () => {
    expect(hrefIn('/folder/f1', 'n1')).toBe('/folder/f1?note=n1')
    expect(hrefIn('/inbox', 'n1')).toBe('/inbox?note=n1')
    expect(hrefIn('/tags/garden', 'n1')).toBe('/tags/garden?note=n1')
    expect(hrefIn('/search?q=soup&tag=food', 'n1')).toBe('/search?q=soup&tag=food&note=n1')
    expect(hrefIn('/', 'n1')).toBe('/notes/n1')
    expect(hrefIn('/folder/f1', null)).toBe('/folder/f1')

    expect(noteOf('/notes/n1', '')).toBe('n1')
    expect(noteOf('/folder/f1', '?note=n2')).toBe('n2')
    expect(noteOf('/search', '?q=soup&note=n3')).toBe('n3')
    expect(noteOf('/folder/f1', '')).toBeNull()
    // Pages of their own carry no note beside a list.
    expect(noteOf('/trash', '?note=n1')).toBeNull()
    expect(noteOf('/notes/n1/history', '')).toBeNull()

    expect(listOf('/folder/f1', '?note=n2')).toBe('/folder/f1')
    expect(listOf('/search', '?q=soup&note=n3')).toBe('/search?q=soup')
    expect(listOf('/notes/n1', '')).toBe('/')
    // An address of before: the folder's list.
    expect(listOf('/notes/n1', '?folder=f1')).toBe('/folder/f1')

    expect(folderOfList('/folder/f1')).toBe('f1')
    expect(folderOfList('/inbox')).toBe('inbox')
    expect(folderOfList('/search?q=x')).toBeNull()
    expect(folderOfList('/')).toBeNull()

    for (const path of ['/', '/notes/n1', '/folder/f1', '/inbox', '/folders', '/tags', '/tags/x', '/search']) expect(isListPath(path)).toBe(true)
    for (const path of ['/trash', '/settings', '/notes/n1/history', '/about']) expect(isListPath(path)).toBe(false)
  })

  it('NOTES-8 AC-9 NOTES-3 AC-9 another list keeps the notes open on a wide screen; another note in the tab does not', () => {
    wide(true)
    loadAccountTabs(1)
    tabs.openHere('n1', 'f1')
    tabs.openInNewTab('n2', 'f1')
    // Another list, the same note, a note with a tab: nothing closes, nothing is asked.
    expect(keepsNotesOpen('/folder/f2')).toBe(true)
    expect(keepsNotesOpen('/search?q=soup')).toBe(true)
    expect(keepsNotesOpen('/folder/f2?note=n2')).toBe(true)
    expect(keepsNotesOpen('/folder/f2?note=n1')).toBe(true)
    // A note without a tab takes the place of the note on show; a page of its own covers the notes.
    expect(keepsNotesOpen('/folder/f2?note=n9')).toBe(false)
    expect(keepsNotesOpen('/trash')).toBe(false)
    // On a phone one view at a time: every other view leaves the note.
    wide(false)
    expect(keepsNotesOpen('/folder/f2')).toBe(false)
  })
})

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'

import { FolderMark } from './FolderMark'

let host: HTMLDivElement | null = null

function draw(folder: { icon: string; color: string }): Element {
  host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  act(() => root.render(<FolderMark folder={folder} />))
  return host.firstElementChild!
}

afterEach(() => {
  host?.remove()
  host = null
})

describe('FolderMark', () => {
  it('NOTES-4 AC-10 a folder without a symbol of its own shows the folder symbol, never a bare square', () => {
    const mark = draw({ icon: '', color: 'honey' })
    expect(mark.tagName.toLowerCase()).toBe('svg')
    expect(mark.getAttribute('data-symbol')).toBe('folder')
  })

  it('NOTES-4 AC-10 a folder with a symbol of its own keeps it', () => {
    expect(draw({ icon: 'heart', color: '' }).getAttribute('data-symbol')).toBe('heart')
  })
})

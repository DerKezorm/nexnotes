/**
 * Where a list of the workspace stands (NOTES-8 AC-9): alone over the whole width (a page), or as the column in the
 * middle beside the notes. The lists (all notes, a folder, the inbox, a tag, the search) take their room from it.
 */
import { createContext, useContext, useEffect } from 'react'

import { pageTitle } from '../lib/title'

export type ListPlace = 'page' | 'column'

export const ListPlaceContext = createContext<ListPlace>('page')

/** Beside one note or two with the list as a column: folds the column away to the narrow strip at the left edge
 * (NOTES-8 AC-9, sixth review; one note too since 24.11.2026). On a page of its own there is nothing to fold: null. */
export const ListCollapseContext = createContext<(() => void) | null>(null)

/** The padding of a list: a page's on its own, a narrow one in the column beside the notes. */
export function useListPadding(): string {
  return useContext(ListPlaceContext) === 'column' ? 'px-3 py-4' : 'px-4 py-5 md:px-8 md:py-6'
}

export function useListPlace(): ListPlace {
  return useContext(ListPlaceContext)
}

/** The browser tab names the list only while it stands alone; beside the notes the open note names it. */
export function useListTitle(text: string | null | undefined): void {
  const place = useListPlace()
  useEffect(() => {
    if (place === 'page') document.title = pageTitle(text)
  }, [place, text])
}

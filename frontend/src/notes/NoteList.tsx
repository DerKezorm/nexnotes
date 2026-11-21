/**
 * Placeholder, replaced by the editor branch: the list of the notes of a folder comes with the note editor (NOTES-3).
 * The folder pages already show it in its place, so that they need no change when the real one arrives.
 */
export function NoteList({ folderId }: { folderId?: string }) {
  return <div data-testid="note-list" data-folder={folderId ?? ''} />
}

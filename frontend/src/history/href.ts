/** Where the history of a note opens, and with which version chosen. */
export function historyHref(noteId: string, versionId?: number): string {
  return `/notes/${encodeURIComponent(noteId)}/history${versionId ? `?v=${versionId}` : ''}`
}

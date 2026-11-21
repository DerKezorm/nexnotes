/** The papers a note can be written on (NOTES-3 AC-17); the server knows the same (`PAPERS` in services/notes.py). */
export const PAPERS = ['blank', 'lined', 'grid', 'dots'] as const
export type Paper = (typeof PAPERS)[number]

export function paperOf(value: string | null | undefined): Paper {
  return (PAPERS as readonly string[]).includes(value ?? '') ? (value as Paper) : 'blank'
}

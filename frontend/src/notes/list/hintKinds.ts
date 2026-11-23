/**
 * The kinds of hints a note can carry in a list (NOTES-6, NOTESIOS-6 AC-1): the progress of its checklists, how many
 * attachments it holds, its tags; each kind on or off for the account (`look.ts`). Here without the store, so that the
 * layout and the rows can use it.
 */

export const HINT_KINDS = ['checklist', 'attachments', 'tags'] as const
export type HintKind = (typeof HINT_KINDS)[number]
export type HintKinds = Record<HintKind, boolean>

export const ALL_HINTS: HintKinds = { checklist: true, attachments: true, tags: true }
export const NO_HINTS: HintKinds = { checklist: false, attachments: false, tags: false }

/** The kinds a list hands its notes: `true` all of them (a list without the account's look), `false` none. */
export function hintKinds(hints: HintKinds | boolean | undefined): HintKinds {
  if (hints === true) return ALL_HINTS
  if (!hints) return NO_HINTS
  return hints
}

/** Whether any kind of hint shows. */
export function anyHints(hints: HintKinds | boolean | undefined): boolean {
  const kinds = hintKinds(hints)
  return HINT_KINDS.some((kind) => kinds[kind])
}

export function sameKinds(a: HintKinds, b: HintKinds): boolean {
  return HINT_KINDS.every((kind) => a[kind] === b[kind])
}

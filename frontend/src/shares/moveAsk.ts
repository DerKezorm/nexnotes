/** The question before notes leave a shared folder (NOTES-13 EC-2): asked through the server, answered in
 * `MoveQuestion`. */
import { useSyncExternalStore } from 'react'

import { sharesApi } from './api'

export type Question = { notes: { id: string; title: string; people: string[] }[]; answer: (go: boolean) => void }

let question: Question | null = null
const listeners = new Set<() => void>()

function publish(next: Question | null): void {
  question = next
  for (const listener of listeners) listener()
}

/** Asks when moving would end sharing for somebody; true when the notes may go. A failed check does not hold the move
 * up: the server keeps the rights in any case. */
export async function askMoveOut(noteIds: string[], targetId: string | null): Promise<boolean> {
  let found: Question['notes']
  try {
    found = (await sharesApi.moveCheck(noteIds, targetId)).notes
  } catch {
    return true
  }
  if (found.length === 0) return true
  question?.answer(false)
  return new Promise<boolean>((resolve) => {
    publish({
      notes: found,
      answer: (go) => {
        publish(null)
        resolve(go)
      },
    })
  })
}

export function useMoveQuestion(): Question | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => question,
  )
}

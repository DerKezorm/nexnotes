/**
 * A locked note in the editor's place (NOTES-16, `LOCKED_VIEW`): its title with the lock and the password card; with
 * the vault open, the note decrypted here and written in the same editor as every note (`LiveNote`, `sealed`),
 * saved encrypted (`provider.ts`). Closing it, five minutes without use, signing out or a new password elsewhere lock
 * it again (AC-3, EC-6, EC-7); then the card is back, in the tab too (NOTES-8 EC-5).
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import * as Y from 'yjs'

import { LiveNote } from '../editor/NoteEditor'
import type { LockedViewProps } from '../editor/noteParts'
import { problemText } from '../lib/errors'
import { notesApi } from '../notes/api'
import { noteTitle } from '../tabs/meta'
import { vaultApi } from './api'
import { ApiError } from '../api/client'
import { contentAad, fromB64, noteKey, unseal } from './crypto'
import { forget as forgetOpened, remember } from './opened'
import { SealedProvider } from './provider'
import { hold, isOpen, revSeen, subscribe, vaultKey } from './session'
import { UnlockCard } from './dialogs'

/** Sent on `window` when a note's lock was taken off here: its view goes back to the live editor. */
export const NOTE_UNLOCKED_EVENT = 'nexnotes:note-unlocked'

export function LockedNote(props: LockedViewProps) {
  const { noteId, onUnlocked } = props
  const open = useSyncExternalStore(subscribe, isOpen)
  const [title, setTitle] = useState('')
  const [opened, setOpened] = useState<SealedProvider | null>(null)
  const [round, setRound] = useState(0)
  const [problem, setProblem] = useState('')

  useEffect(() => {
    notesApi.get(noteId).then(
      (head) => {
        setTitle(head.title)
        noteTitle(noteId, head.title)
        if (!head.locked) onUnlocked()
      },
      (error) => setProblem(problemText(error)),
    )
  }, [noteId, onUnlocked])

  useEffect(() => {
    const done = (event: Event) => {
      if ((event as CustomEvent<{ noteId: string }>).detail?.noteId === noteId) onUnlocked()
    }
    window.addEventListener(NOTE_UNLOCKED_EVENT, done)
    return () => window.removeEventListener(NOTE_UNLOCKED_EVENT, done)
  }, [noteId, onUnlocked])

  useEffect(() => {
    if (!open) return
    const release = hold()
    let live = true
    let provider: SealedProvider | null = null
    const load = async () => {
      const vault = vaultKey()
      if (!vault) return
      const found = await vaultApi.sealed(noteId)
      const key = await noteKey(vault, noteId)
      // Opens only as the revision the server names (format 2), and never one older than this tab had (a roll back).
      const state = await unseal(key, fromB64(found.content), contentAad(noteId, found.rev))
      if (!revSeen(noteId, found.rev)) throw new ApiError(0, 'vault_rollback')
      if (!live) return
      const doc = new Y.Doc()
      Y.applyUpdate(doc, state, 'vault')
      provider = new SealedProvider(noteId, doc, found.rev, key, found.epoch)
      // Another device saved meanwhile and nothing waits here: its version is loaded (EC-5).
      provider.onNewer = () => setRound((value) => value + 1)
      remember(provider)
      setTitle(found.title)
      setOpened(provider)
    }
    load().catch((error) => {
      if (live) setProblem(problemText(error))
    })
    return () => {
      live = false
      setOpened(null)
      const going = provider
      if (going) {
        forgetOpened(going)
        void going.flush().finally(() => going.destroy())
      }
      release()
    }
  }, [open, noteId, round])

  if (!open || !opened) {
    return (
      <div className="flex min-h-full flex-col items-center md:items-start" data-testid="note-editor" data-status="locked">
        <UnlockCard title={title} />
        {problem && <p className="px-5 text-sm text-bad-500 md:px-10">{problem}</p>}
      </div>
    )
  }
  return <LiveNote {...props} key={`${noteId}:${round}`} provider={opened} sealed />
}

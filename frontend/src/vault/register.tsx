/**
 * The vault docks onto the frame (NOTES-16): the locked note's view in the editor's place, "Sperren" and
 * "Sperre aufheben" in the note's menu, attachments of locked notes encrypted before they leave and decrypted to be
 * shown, versions opened here, and the vault part of Settings, Connections.
 */
import { yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap'
import { Download, File as FileIcon, KeyRound, Lock, LockOpen } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import * as Y from 'yjs'

import { ApiError } from '../api/client'
import { SEALED_BLOCK, type SealedBlockProps } from '../attachments/sealed'
import { registerSender, type Sender } from '../attachments/uploads'
import { LOCKED_VIEW, NOTE_MENU_ITEMS, type NoteMenuContext } from '../editor/noteParts'
import { ACCOUNT_SECTIONS, SHELL_PARTS } from '../extensions'
import { SEALED_HISTORY, type SealedVersion } from '../history/sealed'
import type { ProseNode } from '../history/api'
import { bytes as formatBytes } from '../lib/format'
import { onAccountChange } from '../state/account'
import { Box, Button, Card } from '../vendor/nexui'
import { sendSealed, vaultApi, type VaultStatus } from './api'
import { attachmentAad, contentAad, fromB64, noteKey, openAttachment, packAttachment, seal, sealedVersionAad, toB64, unseal } from './crypto'
import { ChangePasswordDialog, ForgotDialog, LockDialog, RemoveLockDialog } from './dialogs'
import { LockedNote, NOTE_UNLOCKED_EVENT } from './LockedNote'
import { openSealed } from './opened'
import { isOpen, subscribe, vaultKey, vaultVersion } from './session'

// --- The note's menu --------------------------------------------------------------------------------------------

/** Asks the shell's dialog host for a vault dialog (the menu closes at once; the dialog outlives it). */
export const VAULT_DIALOG_EVENT = 'nexnotes:vault-dialog'
type Asked = { kind: 'lock' | 'remove'; noteId: string }

function ask(detail: Asked): void {
  window.dispatchEvent(new CustomEvent<Asked>(VAULT_DIALOG_EVENT, { detail }))
}

function LockItem({ noteId, head, sealed, mine, close }: NoteMenuContext) {
  const { t } = useTranslation()
  // Only the owner locks, and only a note that is not in the trash (a shared note is refused by the server).
  if (!mine || !head?.can_write || head.deleted_at) return null
  const choose = (kind: Asked['kind']) => {
    close()
    ask({ kind, noteId })
  }
  return sealed ? (
    <button type="button" role="menuitem" className="nn-menu-item" data-testid="note-unlock" onClick={() => choose('remove')}>
      <LockOpen className="h-4 w-4" aria-hidden />
      {t('vault.remove.menu')}
    </button>
  ) : (
    <button type="button" role="menuitem" className="nn-menu-item" data-testid="note-lock" onClick={() => choose('lock')}>
      <Lock className="h-4 w-4" aria-hidden />
      {t('vault.lock.menu')}
    </button>
  )
}

/** The vault's dialogs over the page, opened from a note's menu. */
export function VaultDialogs() {
  const [asked, setAsked] = useState<Asked | null>(null)
  useEffect(() => {
    const open = (event: Event) => setAsked((event as CustomEvent<Asked>).detail)
    window.addEventListener(VAULT_DIALOG_EVENT, open)
    return () => window.removeEventListener(VAULT_DIALOG_EVENT, open)
  }, [])
  if (!asked) return null
  if (asked.kind === 'lock') return <LockDialog noteId={asked.noteId} onClose={() => setAsked(null)} />
  return (
    <RemoveLockDialog
      noteId={asked.noteId}
      onClose={() => setAsked(null)}
      onDone={() => {
        setAsked(null)
        window.dispatchEvent(new CustomEvent(NOTE_UNLOCKED_EVENT, { detail: { noteId: asked.noteId } }))
      }}
    />
  )
}

// --- Attachments of locked notes --------------------------------------------------------------------------------

type Opened = { url: string; name: string; mime: string; size: number }
const openedFiles = new Map<string, Promise<Opened>>()

/** Pictures the page shows from a `blob:` address; everything else is only downloaded (never HTML or SVG). */
const PICTURES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp']

function openFile(noteId: string, id: string): Promise<Opened> {
  let found = openedFiles.get(id)
  if (!found) {
    found = (async () => {
      const vault = vaultKey()
      if (!vault) throw new Error('the vault is closed')
      const key = await noteKey(vault, noteId)
      const sealed = new Uint8Array(await (await vaultApi.file(id)).arrayBuffer())
      const { header, data } = await openAttachment(key, sealed, attachmentAad(noteId, id))
      const shown = PICTURES.includes(header.mime) ? header.mime : 'application/octet-stream'
      return { url: URL.createObjectURL(new Blob([data], { type: shown })), name: header.name, mime: shown, size: data.length }
    })()
    openedFiles.set(id, found)
    found.catch(() => openedFiles.delete(id))
  }
  return found
}

function forgetFiles(): void {
  for (const found of openedFiles.values()) void found.then((file) => URL.revokeObjectURL(file.url), () => undefined)
  openedFiles.clear()
}

function SealedBlock({ noteId, id, name, actions }: SealedBlockProps) {
  const { t, i18n } = useTranslation()
  const open = useSyncExternalStore(subscribe, isOpen)
  const [file, setFile] = useState<Opened | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!open) return
    let live = true
    openFile(noteId, id).then(
      (found) => live && setFile(found),
      () => live && setFailed(true),
    )
    return () => {
      live = false
    }
  }, [open, noteId, id])
  const remove = actions.editable && actions.onRemove ? (
    <button type="button" className="nn-btn nn-btn-quiet text-[12.5px]" onClick={actions.onRemove} data-testid="attachment-remove">
      {t('attachments.remove')}
    </button>
  ) : null
  if (file && file.mime.startsWith('image/')) {
    return (
      <figure className="m-0 flex flex-col gap-1.5" data-testid="sealed-picture">
        <img src={file.url} alt={file.name} className="block h-auto max-w-full rounded-[12px]" draggable={false} />
        <figcaption className="flex items-center justify-between gap-3 text-xs text-mist-500">
          <span className="truncate">{file.name}</span>
          {remove}
        </figcaption>
      </figure>
    )
  }
  return (
    <div className="flex items-center gap-3 rounded-[12px] border border-ink-700 bg-ink-850 p-3" data-testid="sealed-file">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[10px] bg-ink-800 text-mist-300">
        {file ? <FileIcon className="h-[18px] w-[18px]" aria-hidden /> : <Lock className="h-[18px] w-[18px]" aria-hidden />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm text-mist-100">{file?.name || name || t('vault.attachment.locked')}</span>
        <span className="text-[12.5px] text-mist-500">{file ? formatBytes(file.size, i18n.language) : failed ? t('vault.attachment.failed') : t('vault.attachment.locked')}</span>
      </span>
      {file && (
        <a href={file.url} download={file.name || 'file'} className="nn-btn nn-btn-ghost h-8 px-3 text-[13px]" data-testid="sealed-download">
          <Download className="h-4 w-4" aria-hidden />
          {t('attachments.download')}
        </a>
      )}
      {remove}
    </div>
  )
}

/** A new file of an open locked note: name and type go inside, encrypted with the note's key, before it leaves. */
const sealedSender = (noteId: string): Sender | null => {
  if (!openSealed(noteId) || !vaultKey()) return null
  return (note, id, file, name, onProgress) => {
    let cancel = () => undefined as void
    let cancelled = false
    const done = (async () => {
      const vault = vaultKey()
      if (!vault) throw new Error('the vault is closed')
      const key = await noteKey(vault, note)
      const packed = packAttachment({ name, mime: file.type || 'application/octet-stream' }, new Uint8Array(await file.arrayBuffer()))
      const sealed = await seal(key, packed, attachmentAad(note, id))
      if (cancelled) throw Object.assign(new Error('cancelled'), { code: 'cancelled' })
      const sending = sendSealed(note, id, new Blob([sealed]), onProgress)
      cancel = sending.cancel
      return sending.done
    })()
    return {
      done,
      cancel: () => {
        cancelled = true
        cancel()
      },
    }
  }
}

// --- Versions -----------------------------------------------------------------------------------------------------

async function openVersion(noteId: string, version: SealedVersion): Promise<ProseNode | null> {
  const vault = vaultKey()
  if (!vault) return null
  const state = await unseal(await noteKey(vault, noteId), fromB64(version.content_sealed), sealedVersionAad(noteId, version))
  const doc = new Y.Doc()
  Y.applyUpdate(doc, state)
  return yXmlFragmentToProsemirrorJSON(doc.getXmlFragment('body')) as ProseNode
}

async function restoreVersion(noteId: string, version: SealedVersion): Promise<void> {
  const vault = vaultKey()
  if (!vault) throw new Error('the vault is closed')
  const key = await noteKey(vault, noteId)
  const state = await unseal(key, fromB64(version.content_sealed), sealedVersionAad(noteId, version))
  const doc = new Y.Doc()
  Y.applyUpdate(doc, state)
  const current = await vaultApi.sealed(noteId)
  const send = async (rev: number) =>
    vaultApi.save({
      note: noteId,
      content: toB64(await seal(key, state, contentAad(noteId, rev))),
      base_rev: current.rev,
      rev,
      epoch: current.epoch,
      title: doc.getText('title').toString(),
      restored_from: version.id,
    })
  try {
    await send(current.rev + 1)
  } catch (error) {
    if (!(error instanceof ApiError && error.code === 'vault_stale')) throw error
    await send(Number(error.values.rev ?? current.rev) + 1)
  }
}

// --- Settings, Connections ----------------------------------------------------------------------------------------

export function VaultSection() {
  const { t } = useTranslation()
  const [status, setStatus] = useState<VaultStatus | null>(null)
  const [dialog, setDialog] = useState<'change' | 'forgot' | null>(null)
  const changed = useSyncExternalStore(subscribe, vaultVersion)
  useEffect(() => {
    vaultApi.status().then(setStatus, () => setStatus(null))
  }, [dialog, changed])
  return (
    <Card icon={KeyRound} title={t('vault.section.title')} subtitle={t('vault.section.text')} id="vault">
      {status && !status.set_up && (
        <p className="m-0 text-sm text-[var(--nexui-text-muted)]" data-testid="vault-none">
          {t('vault.section.none')}
        </p>
      )}
      {status?.set_up && (
        <Box
          title={t('vault.section.title')}
          hint={<span data-testid="vault-count">{t('vault.section.count', { count: status.locked_notes })}</span>}
          actions={
            <>
              <Button kind="secondary" icon="KeyRound" onClick={() => setDialog('change')} testId="vault-change-open">
                {t('vault.change.title')}
              </Button>
              <Button kind="secondary" icon="RefreshCw" onClick={() => setDialog('forgot')} testId="vault-forgot-open">
                {t('vault.forgot.link')}
              </Button>
            </>
          }
        />
      )}
      {dialog === 'change' && <ChangePasswordDialog onClose={() => setDialog(null)} />}
      {dialog === 'forgot' && <ForgotDialog onClose={() => setDialog(null)} />}
    </Card>
  )
}

LOCKED_VIEW.render = (props) => <LockedNote {...props} />
if (!NOTE_MENU_ITEMS.includes(LockItem)) NOTE_MENU_ITEMS.push(LockItem)
SEALED_BLOCK.render = (props) => <SealedBlock {...props} />
registerSender(sealedSender)
SEALED_HISTORY.open = openVersion
SEALED_HISTORY.restore = restoreVersion
// The vault password is a password of the account: Settings, Security, after the read links.
if (!ACCOUNT_SECTIONS.some((section) => section.key === 'vault')) ACCOUNT_SECTIONS.push({ key: 'vault', render: () => <VaultSection /> })
if (!SHELL_PARTS.some((part) => part.key === 'vault-dialogs')) SHELL_PARTS.push({ key: 'vault-dialogs', render: () => <VaultDialogs /> })
// The decrypted files go with the key: closed vault, another account.
subscribe(() => {
  if (!isOpen()) forgetFiles()
})
onAccountChange(forgetFiles)

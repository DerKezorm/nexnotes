/**
 * What the vault does with a note (NOTES-16), in this browser:
 *
 * - **Locking** (AC-2): the server stops the note and hands over the whole Yjs state, every version and the ids of
 *   the attachments; each is encrypted here with the note's key and laid down, then the server swaps them in one step
 *   and removes what was plain. Broken off, the note is as it was.
 * - **Taking the lock off** (AC-4): the same backwards; the attachments come back as files the server checks anew.
 * - **Setting up, a new password, a new vault** (AC-1, AC-5, EC-2).
 */
import { currentAccount } from '../state/account'
import { vaultApi } from './api'
import { attachmentAad, contentAad, fromB64, makeVault, noteKey, openAttachment, packAttachment, rewrapVault, seal, sealedVersionAad, unseal, versionAad, WeakKdfError } from './crypto'
import { checkFor, forgetRev, takeKey, vaultKey } from './session'

/** Steps of a lock or unlock, for the progress the dialog shows. */
export type Progress = (done: number, of: number) => void

async function bytes(blob: Blob): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await blob.arrayBuffer())
}

/** The first lock: the vault of the account (AC-1). The key stays open in this tab. */
export async function setUpVault(password: string): Promise<void> {
  const made = await makeVault(password, currentAccount() ?? 0)
  const status = await vaultApi.setup({ kdf: made.kdf, wrapped_key: made.wrapped_key, auth: made.auth, understood: true })
  takeKey(made.key, status.epoch ?? 1)
}

export async function lockNote(noteId: string, progress: Progress = () => undefined): Promise<void> {
  const vault = vaultKey()
  if (!vault) throw new Error('the vault is not open')
  const key = await noteKey(vault, noteId)
  const start = await vaultApi.lockStart(noteId)
  try {
    const steps = 1 + start.versions.length + start.attachments.length
    let done = 0
    const step = () => progress(++done, steps)
    // Format 2: the content for the revision the server names, each version for its id.
    await vaultApi.stage(noteId, 'lock', 'content', await seal(key, fromB64(start.state), contentAad(noteId, start.rev)))
    step()
    for (const version of start.versions) {
      await vaultApi.stage(noteId, 'lock', `version:${version.id}`, await seal(key, fromB64(version.state), versionAad(noteId, version.id)))
      step()
    }
    for (const attachmentId of start.attachments) {
      const info = await vaultApi.info(attachmentId)
      const data = await bytes(await vaultApi.file(attachmentId))
      const packed = packAttachment({ name: info.name, mime: info.mime }, data)
      await vaultApi.stage(noteId, 'lock', `attachment:${attachmentId}`, await seal(key, packed, attachmentAad(noteId, attachmentId)))
      step()
    }
    await vaultApi.lock(noteId)
    forgetRev(noteId)
  } catch (error) {
    await vaultApi.lockCancel(noteId).catch(() => undefined)
    throw error
  }
}

export async function unlockNote(noteId: string, progress: Progress = () => undefined): Promise<void> {
  const vault = vaultKey()
  if (!vault) throw new Error('the vault is not open')
  const key = await noteKey(vault, noteId)
  const start = await vaultApi.unlockStart(noteId)
  try {
    const steps = 1 + start.versions.length + start.attachments.length
    let done = 0
    const step = () => progress(++done, steps)
    await vaultApi.stage(noteId, 'unlock', 'content', await unseal(key, fromB64(start.content), contentAad(noteId, start.rev)))
    step()
    for (const version of start.versions) {
      await vaultApi.stage(noteId, 'unlock', `version:${version.id}`, await unseal(key, fromB64(version.content), sealedVersionAad(noteId, version)))
      step()
    }
    const names: Record<string, string> = {}
    for (const attachmentId of start.attachments) {
      const sealed = await bytes(await vaultApi.file(attachmentId))
      const { header, data } = await openAttachment(key, sealed, attachmentAad(noteId, attachmentId))
      names[attachmentId] = header.name
      await vaultApi.stage(noteId, 'unlock', `attachment:${attachmentId}`, data)
      step()
    }
    await vaultApi.unlockNote(noteId, names)
    forgetRev(noteId)
  } catch (error) {
    await vaultApi.unlockCancel(noteId).catch(() => undefined)
    throw error
  }
}

/** A new password (AC-5): the old one opens the wrapped key, the new one wraps the same key. Wrong old passwords are
 * counted like any (EC-1). */
export async function changePassword(oldPassword: string, newPassword: string): Promise<'ok' | 'wrong' | 'wait' | 'weak'> {
  let old: Awaited<ReturnType<typeof checkFor>>
  try {
    old = await checkFor(oldPassword)
  } catch (error) {
    if (error instanceof WeakKdfError) return 'weak'
    throw error
  }
  if (!old) throw new Error('no vault')
  let wrapped: string
  try {
    wrapped = (await vaultApi.unlock(old.auth)).wrapped_key
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'vault_wrong') return 'wrong'
    if (code === 'vault_wait') return 'wait'
    throw error
  }
  const next = await rewrapVault(old.kek, wrapped, newPassword, currentAccount() ?? 0)
  await vaultApi.password({ ...next, auth_old: old.auth })
  return 'ok'
}

/** "Passwort vergessen …" (EC-2): a new vault; every locked note goes, only when `count` is what the server counts.
 * The account proves once more that it is itself: its password and a code of its second factor (`confirm`), or a
 * sign-in at its provider from the last minutes. */
export async function resetVault(password: string, count: number, confirm: { current_password: string; code: string } = { current_password: '', code: '' }): Promise<number> {
  const made = await makeVault(password, currentAccount() ?? 0)
  const answer = await vaultApi.reset({ kdf: made.kdf, wrapped_key: made.wrapped_key, auth: made.auth, understood: true, count, ...confirm })
  takeKey(made.key, answer.epoch ?? 1)
  return answer.removed
}

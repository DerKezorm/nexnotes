/**
 * The vault's cryptography (NOTES-16), WebCrypto only: nothing self-made.
 *
 * - **Password → keys:** PBKDF2-HMAC-SHA-256 (600,000 rounds, 16 random bytes of salt per account) gives 32 bytes;
 *   HKDF-SHA-256 makes of them the key that wraps the vault key (`nexnotes vault kek v1`, AES-256-GCM) and the check
 *   value the server compares (`nexnotes vault auth v1`). The password never leaves this module.
 * - **Vault key:** 32 random bytes, wrapped with AES-256-GCM (AAD `nexnotes vault key v1|<account>`). Opened, it lives
 *   only as a non-extractable HKDF key; its bytes are overwritten right after the import.
 * - **Per note:** HKDF-SHA-256 of the vault key with `nexnotes note v1|<note>` gives the note's AES-256-GCM key.
 * - **A sealed part:** `0x01`, a fresh 96-bit nonce from `crypto.getRandomValues`, the ciphertext with its tag. AAD
 *   binds it to its place: `nexnotes sealed v1|note|<note>` (content, versions) or
 *   `nexnotes sealed v1|attachment|<note>|<attachment>`. An attachment's plain bytes are the length of a JSON header
 *   (4 bytes, big-endian), the header `{name, mime}` and the file.
 *
 * The same in Python for the server's tests: `backend/tests/vault_client.py`; the iOS app does it with CommonCrypto
 * (PBKDF2) and CryptoKit (HKDF, AES-GCM).
 */

export const KDF_ITERATIONS = 600_000
const FORMAT = 1
const NONCE = 12

export type Kdf = { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number; salt: string }

const encoder = new TextEncoder()
const bytesOf = (text: string): Uint8Array<ArrayBuffer> => encoder.encode(text) as Uint8Array<ArrayBuffer>
const EMPTY = new Uint8Array(0)

export function toB64(bytes: Uint8Array): string {
  let text = ''
  for (let index = 0; index < bytes.length; index += 0x8000) text += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(text)
}

export function fromB64(text: string): Uint8Array<ArrayBuffer> {
  const plain = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(plain.length)
  for (let index = 0; index < plain.length; index++) out[index] = plain.charCodeAt(index)
  return out
}

function random(length: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(length)
  crypto.getRandomValues(out)
  return out
}

/** What a password gives: the key that wraps the vault key, and the check value for the server. */
export type Derived = { kek: CryptoKey; auth: Uint8Array<ArrayBuffer> }

export async function derive(password: string, kdf: Kdf): Promise<Derived> {
  const material = await crypto.subtle.importKey('raw', bytesOf(password), 'PBKDF2', false, ['deriveBits'])
  const master = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromB64(kdf.salt), iterations: kdf.iterations }, material, 256)
  const base = await crypto.subtle.importKey('raw', master, 'HKDF', false, ['deriveKey', 'deriveBits'])
  new Uint8Array(master).fill(0)
  const kek = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: EMPTY, info: bytesOf('nexnotes vault kek v1') },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
  const auth = new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: EMPTY, info: bytesOf('nexnotes vault auth v1') }, base, 256))
  return { kek, auth }
}

export function newKdf(): Kdf {
  return { name: 'PBKDF2', hash: 'SHA-256', iterations: KDF_ITERATIONS, salt: toB64(random(16)) }
}

const wrapAad = (accountId: number) => `nexnotes vault key v1|${accountId}`

/** The vault key as a non-extractable HKDF key; the raw bytes are overwritten. */
async function asVaultKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  try {
    return await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey'])
  } finally {
    raw.fill(0)
  }
}

/** A new vault (AC-1): a random vault key wrapped by the password. */
export async function makeVault(password: string, accountId: number): Promise<{ kdf: Kdf; wrapped_key: string; auth: string; key: CryptoKey }> {
  const kdf = newKdf()
  const { kek, auth } = await derive(password, kdf)
  const raw = random(32)
  const wrapped = await seal(kek, raw, wrapAad(accountId))
  return { kdf, wrapped_key: toB64(wrapped), auth: toB64(auth), key: await asVaultKey(raw) }
}

/** The vault key from what the server handed out for the right check value. Throws when it does not open. */
export async function unwrapVault(kek: CryptoKey, wrapped: string, accountId: number): Promise<CryptoKey> {
  return asVaultKey(await unseal(kek, fromB64(wrapped), wrapAad(accountId)))
}

/** The same vault key wrapped by a new password (AC-5): opened with the old one, wrapped again, never kept. */
export async function rewrapVault(oldKek: CryptoKey, wrapped: string, newPassword: string, accountId: number): Promise<{ kdf: Kdf; wrapped_key: string; auth: string }> {
  const raw = await unseal(oldKek, fromB64(wrapped), wrapAad(accountId))
  try {
    const kdf = newKdf()
    const { kek, auth } = await derive(newPassword, kdf)
    return { kdf, wrapped_key: toB64(await seal(kek, raw, wrapAad(accountId))), auth: toB64(auth) }
  } finally {
    raw.fill(0)
  }
}

/** The key of one note. */
export function noteKey(vaultKey: CryptoKey, noteId: string): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: EMPTY, info: bytesOf(`nexnotes note v1|${noteId}`) },
    vaultKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export const noteAad = (noteId: string) => `nexnotes sealed v1|note|${noteId}`
export const attachmentAad = (noteId: string, attachmentId: string) => `nexnotes sealed v1|attachment|${noteId}|${attachmentId}`

/** AES-256-GCM with a fresh random nonce: `0x01 · nonce · ciphertext and tag`. */
export async function seal(key: CryptoKey, data: Uint8Array<ArrayBuffer>, aad: string): Promise<Uint8Array<ArrayBuffer>> {
  const nonce = random(NONCE)
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: bytesOf(aad) }, key, data))
  const out = new Uint8Array(1 + NONCE + sealed.length)
  out[0] = FORMAT
  out.set(nonce, 1)
  out.set(sealed, 1 + NONCE)
  return out
}

/** Opens a sealed part; throws for another key, another place (AAD) or a changed byte. */
export async function unseal(key: CryptoKey, blob: Uint8Array<ArrayBuffer>, aad: string): Promise<Uint8Array<ArrayBuffer>> {
  if (blob.length < 1 + NONCE + 16 || blob[0] !== FORMAT) throw new Error('not a sealed part')
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: blob.slice(1, 1 + NONCE), additionalData: bytesOf(aad) }, key, blob.slice(1 + NONCE))
  return new Uint8Array(plain)
}

export type AttachmentHeader = { name: string; mime: string }

export function packAttachment(header: AttachmentHeader, data: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const head = bytesOf(JSON.stringify({ name: header.name, mime: header.mime }))
  const out = new Uint8Array(4 + head.length + data.length)
  new DataView(out.buffer).setUint32(0, head.length)
  out.set(head, 4)
  out.set(data, 4 + head.length)
  return out
}

export function unpackAttachment(plain: Uint8Array<ArrayBuffer>): { header: AttachmentHeader; data: Uint8Array<ArrayBuffer> } {
  const length = new DataView(plain.buffer, plain.byteOffset).getUint32(0)
  const parsed = JSON.parse(new TextDecoder().decode(plain.subarray(4, 4 + length))) as Partial<AttachmentHeader>
  return { header: { name: String(parsed.name ?? ''), mime: String(parsed.mime ?? 'application/octet-stream') }, data: plain.slice(4 + length) }
}

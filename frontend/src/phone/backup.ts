// Passphrase-locked backups. Everything personal is sealed into one file you can keep in iCloud
// Drive, on a USB thumb drive (Files app), or anywhere. Without the passphrase it's unreadable.
//
// Key: PBKDF2-SHA-256 with a random 16-byte salt and 600,000 rounds (OWASP's 2023 guidance for
// PBKDF2-SHA-256), via the browser's built-in Web Crypto. Cipher: AES-256-GCM with a random
// 12-byte nonce. GCM's tag proves the file wasn't changed: a wrong passphrase or a tampered file
// fails to open, and nothing is ever half-restored. The header is authenticated too.
import { parseData, type PhoneData } from './store'

export const FORMAT = 'keystone-ledger-backup'
export const ITERATIONS = 600_000
export const MIN_PASSPHRASE = 10

interface Envelope {
  format: typeof FORMAT
  version: 1
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number; salt: string }
  cipher: { name: 'AES-GCM'; iv: string }
  saved_at: string
  data: string
}

function b64(bytes: Uint8Array): string {
  // In chunks: spreading a large array into one call overflows the stack.
  let out = ''
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(out)
}
const unb64 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

async function deriveKey(passphrase: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

/** The parts of the header that must not change; bound to the ciphertext as extra data. */
const aad = (e: Omit<Envelope, 'data'>) => new TextEncoder().encode(JSON.stringify([e.format, e.version, e.kdf, e.cipher, e.saved_at]))

export async function encryptBackup(data: PhoneData, passphrase: string, now = new Date(), iterations = ITERATIONS): Promise<string> {
  if (passphrase.length < MIN_PASSPHRASE) throw new Error(`Use a passphrase of at least ${String(MIN_PASSPHRASE)} characters.`)
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const head: Omit<Envelope, 'data'> = {
    format: FORMAT, version: 1,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: b64(salt) },
    cipher: { name: 'AES-GCM', iv: b64(iv) },
    saved_at: now.toISOString(),
  }
  const key = await deriveKey(passphrase, salt, iterations)
  const plain = new TextEncoder().encode(JSON.stringify(data))
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(head) }, key, plain))
  return JSON.stringify({ ...head, data: b64(sealed) })
}

export function isEncrypted(raw: unknown): boolean {
  return typeof raw === 'object' && raw !== null && (raw as { format?: unknown }).format === FORMAT
}

/** Opens a backup file's text. Encrypted files need the passphrase; older plain backups don't.
 * Either way the result is fully validated before anything uses it. */
export async function openBackup(text: string, passphrase: string | null): Promise<{ data: PhoneData; saved_at: string | null; encrypted: boolean }> {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('That file isn’t a Keystone Ledger backup.')
  }
  if (!isEncrypted(raw)) return { data: parseData(raw), saved_at: null, encrypted: false }
  // Untrusted file: check every field before trusting any of it.
  const u = raw as { version?: unknown; kdf?: Record<string, unknown>; cipher?: Record<string, unknown>; saved_at?: unknown; data?: unknown }
  const kdf = u.kdf ?? {}
  const cipher = u.cipher ?? {}
  const iterations = kdf.iterations
  if (u.version !== 1 || kdf.name !== 'PBKDF2' || kdf.hash !== 'SHA-256' || cipher.name !== 'AES-GCM'
    || typeof iterations !== 'number' || !Number.isInteger(iterations) || iterations < 100_000 || iterations > 10_000_000
    || typeof kdf.salt !== 'string' || typeof cipher.iv !== 'string' || typeof u.data !== 'string' || typeof u.saved_at !== 'string') {
    throw new Error('This backup uses a format this app can’t open.')
  }
  const e: Envelope = {
    format: FORMAT, version: 1,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: kdf.salt },
    cipher: { name: 'AES-GCM', iv: cipher.iv },
    saved_at: u.saved_at, data: u.data,
  }
  if (!passphrase) throw new Error('Type the passphrase for this backup.')
  let plain: ArrayBuffer
  try {
    const key = await deriveKey(passphrase, unb64(e.kdf.salt), e.kdf.iterations)
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(e.cipher.iv), additionalData: aad(e) }, key, unb64(e.data))
  } catch {
    throw new Error('Wrong passphrase, or the file was changed or damaged. Nothing was restored.')
  }
  let inner: unknown
  try {
    inner = JSON.parse(new TextDecoder().decode(plain))
  } catch {
    throw new Error('The backup opened but its contents are damaged. Nothing was restored.')
  }
  return { data: parseData(inner), saved_at: e.saved_at, encrypted: true }
}

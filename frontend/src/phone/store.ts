// Everything personal lives here, on the phone, never on a server.
// Stored in this app's private browser storage; the Backup button saves a copy you can keep in
// iCloud Drive / Files. Every load (including restoring a backup) is strictly validated.
import type { Entry } from './logic'

const KEY = 'keystone.phone.v1'
const SYMBOL = /^\^?[A-Z0-9]{1,10}([.-][A-Z0-9]{1,4})?$/
const MONTH = /^(199\d|20\d\d)-(0[1-9]|1[0-2])$/
const MAX_ENTRIES = 2000
const MAX_HOLDINGS = 50

export interface PhoneData {
  version: 1
  holdings: Record<string, number> // symbol -> dollar value you typed in
  values_as_of: string | null // when you last updated those values
  entries: Entry[] // the wall
}

export const empty = (): PhoneData => ({ version: 1, holdings: {}, values_as_of: null, entries: [] })

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Parse untrusted JSON (storage or a backup file). Throws a plain-English error if invalid. */
export function parseData(raw: unknown): PhoneData {
  if (!isObj(raw) || raw.version !== 1) throw new Error('This isn’t a Keystone Ledger backup file.')
  const holdings: Record<string, number> = {}
  if (!isObj(raw.holdings)) throw new Error('The backup’s holdings are damaged.')
  const hs = Object.entries(raw.holdings)
  if (hs.length > MAX_HOLDINGS) throw new Error('The backup has too many holdings.')
  for (const [sym, v] of hs) {
    if (!SYMBOL.test(sym) || typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1e10) {
      throw new Error(`The backup has a bad holding: ${sym.slice(0, 16)}`)
    }
    holdings[sym] = v
  }
  const asOf = raw.values_as_of
  if (asOf !== null && (typeof asOf !== 'string' || Number.isNaN(Date.parse(asOf)))) throw new Error('The backup’s date is damaged.')
  if (!Array.isArray(raw.entries) || raw.entries.length > MAX_ENTRIES) throw new Error('The backup’s wall is damaged.')
  const entries: Entry[] = raw.entries.map((e: unknown) => {
    if (!isObj(e)) throw new Error('The backup’s wall is damaged.')
    const { id, month, amount, note, created_at } = e
    if (typeof id !== 'string' || id.length > 64 || typeof month !== 'string' || !MONTH.test(month)
      || typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0 || amount > 1e7
      || typeof note !== 'string' || note.length > 120 || typeof created_at !== 'string') {
      throw new Error('The backup has a damaged wall entry.')
    }
    return { id, month, amount, note, created_at }
  })
  return { version: 1, holdings, values_as_of: asOf, entries }
}

export function load(): PhoneData {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? parseData(JSON.parse(raw)) : empty()
  } catch {
    return empty()
  }
}

export function save(d: PhoneData): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(d))
    return true
  } catch {
    return false
  }
}

/** Ask the browser not to clear our storage when space runs low (best effort). */
export async function askPersistent(): Promise<void> {
  try {
    if (await navigator.storage.persisted()) return
    await navigator.storage.persist()
  } catch {
    // not supported: the Backup button is the safety net
  }
}

export function newId(): string {
  const a = new Uint8Array(8)
  crypto.getRandomValues(a)
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function backupBlob(d: PhoneData): Blob {
  return new Blob([JSON.stringify({ ...d, app: 'keystone-ledger', saved_at: new Date().toISOString() }, null, 1)], {
    type: 'application/json',
  })
}

export async function readBackup(file: File): Promise<PhoneData> {
  if (file.size > 2_000_000) throw new Error('That file is too big to be a backup.')
  let parsed: unknown
  try {
    parsed = JSON.parse(await file.text())
  } catch {
    throw new Error('That file isn’t a Keystone Ledger backup.')
  }
  return parseData(parsed)
}

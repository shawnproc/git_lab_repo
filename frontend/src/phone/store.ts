// Everything personal lives here, on the phone, never on a server.
// Stored in this app's private browser storage; the Backup button saves a copy you can keep in
// iCloud Drive / Files. Every load (including restoring a backup) is strictly validated.
import type { Entry } from './logic'
import type { Trade } from './robinhood'
import { CADENCES, type Schedule } from './schedule'

const KEY = 'keystone.phone.v1'
const SYMBOL = /^\^?[A-Z0-9]{1,10}([.-][A-Z0-9]{1,4})?$/
const MONTH = /^(199\d|20\d\d)-(0[1-9]|1[0-2])$/
const MAX_ENTRIES = 2000
const MAX_HOLDINGS = 50
const MAX_TRADES = 20_000
/** Allowed funds/stocks splits (% in the index funds). The 10% per-company cap applies to all. */
export const CORE_CHOICES = [60, 70, 80] as const
const DAY = /^(199\d|20\d\d)-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/
const SOURCES = new Set(['robinhood', 'adjust', 'stone'])
export const MAX_WATCH = 50
/** Search picks you can add to your buy days (each still under the per-company cap). */
export const MAX_INCLUDED = 5
const WATCH_VERDICTS = new Set(['fit', 'pricey', 'no', 'unknown', 'fund'])

/** A company you saved from Search, to follow and maybe invest in later. */
export interface WatchItem {
  symbol: string
  added_at: string // ISO time you saved it
  added_price: number | null // its last close when you saved it
  verdict_at_add: string // the verdict back then, so a change can be shown
  include: boolean // add it to your buy days (only while it's still a "Good fit")
}

export interface PhoneData {
  version: 1
  holdings: Record<string, number> // symbol -> dollar value you typed in (tickers with no price)
  shares: Record<string, number> // symbol -> shares you own (value = shares x last close)
  trades: Trade[] // share changes from a Robinhood import (and later edits), for real history
  schedule: Schedule | null // your buy days and amount (null until you set one)
  core_pct: number | null // your funds/stocks split: 60, 70 or 80 (% in the index funds)
  last_backup_at: string | null // when you last saved a backup file
  values_as_of: string | null // when you last updated those values
  entries: Entry[] // the wall
  watchlist: WatchItem[] // companies saved from Search
}

export const empty = (): PhoneData => ({ version: 1, holdings: {}, shares: {}, trades: [], schedule: null, core_pct: null, last_backup_at: null, values_as_of: null, entries: [], watchlist: [] })

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function numberMap(raw: Record<string, unknown>, max: number): Record<string, number> {
  const out: Record<string, number> = {}
  const items = Object.entries(raw)
  if (items.length > MAX_HOLDINGS) throw new Error('The backup has too many holdings.')
  for (const [sym, v] of items) {
    if (!SYMBOL.test(sym) || typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > max) {
      throw new Error(`The backup has a bad holding: ${sym.slice(0, 16)}`)
    }
    out[sym] = v
  }
  return out
}

/** Parse untrusted JSON (storage or a backup file). Throws a plain-English error if invalid. */
export function parseData(raw: unknown): PhoneData {
  if (!isObj(raw) || raw.version !== 1) throw new Error('This isn’t a Keystone Ledger backup file.')
  if (!isObj(raw.holdings)) throw new Error('The backup’s holdings are damaged.')
  const holdings = numberMap(raw.holdings, 1e10)
  // Backups from before share counts existed have no `shares`: that's fine.
  if (raw.shares !== undefined && !isObj(raw.shares)) throw new Error('The backup’s share counts are damaged.')
  const shares = raw.shares === undefined ? {} : numberMap(raw.shares, 1e9)
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
  if (raw.trades !== undefined && (!Array.isArray(raw.trades) || raw.trades.length > MAX_TRADES)) throw new Error('The backup’s trade history is damaged.')
  const trades: Trade[] = (raw.trades ?? []).map((t: unknown) => {
    if (!isObj(t)) throw new Error('The backup’s trade history is damaged.')
    const { day, symbol, qty, source, split } = t
    if (typeof day !== 'string' || !DAY.test(day) || typeof symbol !== 'string' || !SYMBOL.test(symbol)
      || typeof qty !== 'number' || !Number.isFinite(qty) || Math.abs(qty) > 1e9
      || typeof source !== 'string' || !SOURCES.has(source) || (split !== undefined && typeof split !== 'boolean')) {
      throw new Error('The backup has a damaged trade.')
    }
    return { day, symbol, qty, source: source as Trade['source'], ...(split ? { split: true } : {}) }
  })
  let schedule: Schedule | null = null
  if (raw.schedule !== undefined && raw.schedule !== null) {
    const sc = raw.schedule
    if (!isObj(sc) || typeof sc.cadence !== 'string' || !(CADENCES as readonly string[]).includes(sc.cadence)
      || typeof sc.amount !== 'number' || !Number.isFinite(sc.amount) || sc.amount <= 0 || sc.amount > 1e6
      || typeof sc.anchor !== 'string' || !DAY.test(sc.anchor)) {
      throw new Error('The backup’s buy schedule is damaged.')
    }
    schedule = { cadence: sc.cadence as Schedule['cadence'], amount: sc.amount, anchor: sc.anchor }
  }
  const corePct = raw.core_pct ?? null
  if (corePct !== null && !(CORE_CHOICES as readonly unknown[]).includes(corePct)) throw new Error('The backup’s fund/stock split is damaged.')
  const lastBackup = raw.last_backup_at ?? null
  if (lastBackup !== null && (typeof lastBackup !== 'string' || Number.isNaN(Date.parse(lastBackup)))) throw new Error('The backup’s date is damaged.')
  if (raw.watchlist !== undefined && (!Array.isArray(raw.watchlist) || raw.watchlist.length > MAX_WATCH)) throw new Error('The backup’s watchlist is damaged.')
  const seen = new Set<string>()
  const watchlist: WatchItem[] = (raw.watchlist ?? []).map((w: unknown) => {
    if (!isObj(w)) throw new Error('The backup’s watchlist is damaged.')
    const { symbol, added_at, added_price, verdict_at_add, include } = w
    if (typeof symbol !== 'string' || !SYMBOL.test(symbol) || seen.has(symbol)
      || typeof added_at !== 'string' || added_at.length > 40 || Number.isNaN(Date.parse(added_at))
      || (added_price !== null && (typeof added_price !== 'number' || !Number.isFinite(added_price) || added_price <= 0 || added_price > 1e7))
      || typeof verdict_at_add !== 'string' || !WATCH_VERDICTS.has(verdict_at_add) || typeof include !== 'boolean') {
      throw new Error('The backup has a damaged watchlist entry.')
    }
    seen.add(symbol)
    return { symbol, added_at, added_price, verdict_at_add, include }
  })
  if (watchlist.filter((w) => w.include).length > MAX_INCLUDED) throw new Error('The backup’s watchlist is damaged.')
  return { version: 1, holdings, shares, trades, schedule, core_pct: corePct as number | null, last_backup_at: lastBackup, values_as_of: asOf, entries, watchlist }
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

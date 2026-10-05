// Live prices from Finnhub's free plan, with YOUR key. The key is typed in once and stays in this
// phone's storage only: it's never in the app's code, the public data files or a backup file.
// Live prices are for looking only. Buy amounts and days always use the last close, so a price
// that's moving minute to minute never changes what the plan says.
import { useEffect, useRef, useState } from 'react'

const KEY_STORE = 'keystone.live.v1'
const API = 'https://finnhub.io/api/v1/quote'
const KEY = /^[A-Za-z0-9]{16,64}$/
const SYMBOL = /^[A-Z0-9]{1,10}(\.[A-Z0-9]{1,4})?$/
export const SPACING_MS = 1100 // under the free plan's 60 requests a minute
export const REFRESH_MS = 60_000
export const MAX_LIVE = 25 // symbols refreshed each minute, so the limit is never hit

export interface LiveQuote {
  price: number
  change_pct: number | null
  prev_close: number | null
  at: string // when the price was last traded (ISO)
}

export function validKey(k: string): boolean {
  return KEY.test(k)
}

export function loadKey(): string | null {
  try {
    const k = localStorage.getItem(KEY_STORE)
    return k && validKey(k) ? k : null
  } catch {
    return null
  }
}

export function saveKey(k: string | null): boolean {
  try {
    if (k === null) localStorage.removeItem(KEY_STORE)
    else if (validKey(k)) localStorage.setItem(KEY_STORE, k)
    else return false
    return true
  } catch {
    return false
  }
}

export class LiveError extends Error {
  readonly kind: 'key' | 'limit' | 'other'
  constructor(message: string, kind: 'key' | 'limit' | 'other') {
    super(message)
    this.kind = kind
  }
}

/** Validate Finnhub's /quote reply. All zeros means "no such symbol": that's null, not $0. */
export function parseQuote(raw: unknown, nowMs: number): LiveQuote | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { c, pc, t } = raw as Record<string, unknown>
  if (typeof c !== 'number' || !Number.isFinite(c) || c <= 0 || typeof t !== 'number' || !Number.isFinite(t) || t <= 0) return null
  const ms = t * 1000
  if (ms > nowMs + 5 * 60_000) return null // from the future: broken
  const prev = typeof pc === 'number' && Number.isFinite(pc) && pc > 0 ? pc : null
  return { price: c, prev_close: prev, change_pct: prev ? (c / prev - 1) * 100 : null, at: new Date(ms).toISOString() }
}

export async function fetchLiveQuote(symbol: string, key: string, signal?: AbortSignal): Promise<LiveQuote | null> {
  if (!SYMBOL.test(symbol) || !validKey(key)) return null
  const url = `${API}?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(key)}`
  let res: Response
  try {
    res = await fetch(url, { credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', signal })
  } catch {
    throw new LiveError('Live prices couldn’t be reached. Showing the last close.', 'other')
  }
  if (res.status === 401 || res.status === 403) throw new LiveError('Finnhub didn’t accept your key. Check it in Search → Live prices.', 'key')
  if (res.status === 429) throw new LiveError('Too many live lookups this minute. They’ll resume shortly.', 'limit')
  if (!res.ok) throw new LiveError('Live prices are unavailable right now. Showing the last close.', 'other')
  return parseQuote(await res.json(), Date.now())
}

/** Live quotes for up to MAX_LIVE symbols, refreshed each minute while the app is on screen. */
export function useLiveQuotes(symbols: string[], key: string | null): { quotes: Record<string, LiveQuote>; error: string | null } {
  const [quotes, setQuotes] = useState<Record<string, LiveQuote>>({})
  const [error, setError] = useState<string | null>(null)
  const wanted = symbols.filter((s) => SYMBOL.test(s)).slice(0, MAX_LIVE).join(',')
  const busy = useRef(false)
  useEffect(() => {
    if (!key || !wanted) return
    const list = wanted.split(',')
    const ctrl = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const sleep = (ms: number) => new Promise<void>((r) => { timer = setTimeout(r, ms) })
    async function round() {
      if (busy.current || document.hidden) return
      busy.current = true
      try {
        for (const s of list) {
          if (ctrl.signal.aborted) return
          const q = await fetchLiveQuote(s, key ?? '', ctrl.signal)
          if (q) setQuotes((old) => ({ ...old, [s]: q }))
          setError(null)
          await sleep(SPACING_MS)
        }
      } catch (e) {
        if (!ctrl.signal.aborted) setError(e instanceof Error ? e.message : 'Live prices are unavailable.')
      } finally {
        busy.current = false
      }
    }
    void round()
    const every = setInterval(() => { void round() }, REFRESH_MS)
    const onShow = () => { if (!document.hidden) void round() }
    document.addEventListener('visibilitychange', onShow)
    return () => {
      ctrl.abort()
      clearInterval(every)
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onShow)
      busy.current = false
    }
  }, [wanted, key])
  return { quotes, error }
}

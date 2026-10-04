// Reads Robinhood's "Account activity report" (CSV) on the phone. The file never leaves the device.
// Columns: Activity Date, Process Date, Settle Date, Instrument, Description, Trans Code, Quantity,
// Price, Amount. Money out is written "($900.00)". The file ends with a disclaimer row.
// We only turn rows we understand into share changes; anything else is reported, never guessed.

export type TradeSource = 'robinhood' | 'adjust' | 'stone'

export interface Trade {
  day: string // YYYY-MM-DD
  symbol: string
  qty: number // shares added (+) or removed (-)
  source: TradeSource
  split?: boolean // Robinhood's "SPL" row: shares added by a stock split
}

export interface ImportResult {
  trades: Trade[]
  shares: Record<string, number> // what you own at the end of the report
  months: { month: string; amount: number }[] // new money you put in each month (buys)
  first_day: string | null
  last_day: string | null
  warnings: string[]
  counts: { rows: number; buys: number; sells: number; ignored: number }
}

const MAX_BYTES = 5_000_000
const MAX_ROWS = 50_000
const SYMBOL = /^[A-Z0-9]{1,10}([.-][A-Z0-9]{1,4})?$/
const HEADERS = ['Activity Date', 'Instrument', 'Description', 'Trans Code', 'Quantity', 'Amount'] as const

// Codes that move cash only (no shares): deposits, dividends, interest, fees, lending income...
const CASH_ONLY = new Set(['ACH', 'CDIV', 'MDIV', 'GOLD', 'SLIP', 'INT', 'MINT', 'DFEE', 'AFEE', 'GDBP', 'DTAX', 'FUTSWP', 'RTP', 'XENT', 'WITH', 'DEP', 'MISC', 'GMPC', 'T/A', 'DCF'])
// Corporate actions that move shares: splits (SPL), reverse splits (SPR), mergers (MRGS), symbol or
// CUSIP changes (CONV, SXCH), shares received (REC) and transfers in from another broker (ACATI).
const CORPORATE = new Set(['SPL', 'SPR', 'MRGS', 'CONV', 'SXCH', 'REC', 'ACATI'])
const OPTIONS = new Set(['BTO', 'STO', 'BTC', 'STC', 'OEXP', 'OASGN', 'OEXCS', 'OCA'])

/** RFC 4180 CSV: quoted fields, "" escapes, newlines inside quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i)
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else quoted = false
      } else field += c
      continue
    }
    if (c === '"') quoted = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); rows.push(row); row = []; field = ''
      if (rows.length > MAX_ROWS) throw new Error('That file has too many rows to be an activity report.')
    } else field += c
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row) }
  return rows
}

function parseDay(s: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s.trim())
  if (!m) return null
  const [mo, d, y] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return null
  return `${String(y)}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/** "12.5", "0.810399", "10S" (some split rows) -> number; "" -> 0; junk -> null. */
function parseQty(s: string): number | null {
  const t = s.trim().replace(/,/g, '').replace(/S$/, '')
  if (t === '') return 0
  if (!/^\d*\.?\d+$/.test(t)) return null
  return Number(t)
}

/** "$43.64" -> 43.64, "($43.64)" -> -43.64, "" -> 0, junk -> null. */
export function parseMoney(s: string): number | null {
  let t = s.trim()
  if (t === '') return 0
  let sign = 1
  if (t.startsWith('(') && t.endsWith(')')) { sign = -1; t = t.slice(1, -1) }
  if (t.startsWith('-')) { sign = -sign; t = t.slice(1) }
  t = t.replace(/^\$/, '').replace(/,/g, '')
  if (!/^\d*\.?\d+$/.test(t)) return null
  return sign * Number(t)
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6

export function parseRobinhood(text: string): ImportResult {
  if (text.length > MAX_BYTES) throw new Error('That file is too big to be an activity report.')
  const rows = parseCsv(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) // skip a byte-order mark
  const headerAt = rows.findIndex((r) => HEADERS.every((h) => r.includes(h)))
  if (headerAt < 0) {
    throw new Error('This doesn’t look like a Robinhood account activity report. In Robinhood: Account → Reports and statements → Reports → Generate new report.')
  }
  const head = rows[headerAt] ?? []
  const col = (name: string) => head.indexOf(name)
  const at = { day: col('Activity Date'), sym: col('Instrument'), desc: col('Description'), code: col('Trans Code'), qty: col('Quantity'), amt: col('Amount') }

  // Pass 1: read rows into share events. Pass 2 (below) applies them in date order.
  interface Event { day: string; sym: string; qty: number; split: boolean; removeAll: boolean }
  const events: Event[] = []
  const months = new Map<string, number>()
  const unknown = new Map<string, number>()
  const bad: string[] = []
  const counts = { rows: 0, buys: 0, sells: 0, ignored: 0 }
  let options = 0

  for (const r of rows.slice(headerAt + 1)) {
    const day = parseDay(r[at.day] ?? '')
    if (!day) continue // blank lines and the disclaimer at the end
    counts.rows++
    const code = (r[at.code] ?? '').trim().toUpperCase()
    const sym = (r[at.sym] ?? '').trim().toUpperCase()
    const rawQty = (r[at.qty] ?? '').trim()
    const qty = parseQty(rawQty)
    if (CASH_ONLY.has(code) || code === '') { counts.ignored++; continue }
    if (OPTIONS.has(code)) { options++; counts.ignored++; continue }
    if (qty === null || !SYMBOL.test(sym)) { bad.push(`${day} ${code} ${sym.slice(0, 10)}`); continue }
    if (qty === 0) { counts.ignored++; continue }
    // Corporate actions write shares going OUT with a trailing "S" ("1.021S") and shares coming
    // IN without it: a merger is one "S" row for the old stock and one plain row for the new.
    const out = /S$/i.test(rawQty)
    if (code === 'BUY' || code === 'SELL') {
      if (out) { bad.push(`${day} ${code} ${sym}`); continue }
      events.push({ day, sym, qty: code === 'BUY' ? qty : -qty, split: false, removeAll: false })
      if (code === 'BUY') {
        counts.buys++
        // New money only: reinvested dividends are buys, but not money you added.
        const amt = parseMoney(r[at.amt] ?? '')
        const reinvest = /dividend reinvestment/i.test(r[at.desc] ?? '')
        if (amt !== null && !reinvest) months.set(day.slice(0, 7), (months.get(day.slice(0, 7)) ?? 0) + Math.abs(amt))
      } else counts.sells++
    } else if (CORPORATE.has(code)) {
      events.push({ day, sym, qty: out ? -qty : qty, split: code === 'SPL', removeAll: out })
    } else {
      unknown.set(code, (unknown.get(code) ?? 0) + 1)
    }
  }

  // Pass 2: apply in date order. Robinhood rounds corporate-action quantities (to 4 places, while
  // shares are kept to 6), so an "S" row that removes all but a sliver removes the whole position.
  events.sort((x, y) => (x.day < y.day ? -1 : x.day > y.day ? 1 : 0))
  const byKey = new Map<string, Trade>() // one entry per day + symbol + kind
  const running: Record<string, number> = {}
  const short = new Set<string>()
  for (const e of events) {
    const held = running[e.sym] ?? 0
    const qty = e.removeAll && Math.abs(held + e.qty) < 0.001 ? -held : e.qty
    running[e.sym] = round6(held + qty)
    if ((running[e.sym] ?? 0) < -1e-6) short.add(e.sym)
    const key = `${e.day}|${e.sym}|${e.split ? 's' : 't'}`
    const prev = byKey.get(key)
    byKey.set(key, { day: e.day, symbol: e.sym, qty: round6((prev?.qty ?? 0) + qty), source: 'robinhood', ...(e.split ? { split: true } : {}) })
  }
  const trades = [...byKey.values()].filter((t) => t.qty !== 0).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.symbol < b.symbol ? -1 : 1))
  const warnings: string[] = []
  if (short.size > 0) {
    warnings.push(`The report sells more ${[...short].join(', ')} than it buys, so it probably starts after you first bought. Make a new report starting from when you opened your account.`)
  }
  for (const [code, n] of unknown) warnings.push(`${String(n)} “${code}” row${n === 1 ? '' : 's'} changed shares in a way this app doesn’t understand yet. Check those holdings against your Robinhood app.`)
  if (bad.length > 0) warnings.push(`${String(bad.length)} row${bad.length === 1 ? '' : 's'} couldn’t be read (first: ${bad[0] ?? ''}).`)
  if (options > 0) warnings.push(`${String(options)} options row${options === 1 ? '' : 's'} skipped: this app tracks shares only.`)

  const shares: Record<string, number> = {}
  for (const [s, n] of Object.entries(running)) if (n > 1e-6) shares[s] = n
  const days = trades.map((t) => t.day)
  return {
    trades,
    shares,
    months: [...months.entries()].sort().map(([month, amount]) => ({ month, amount: Math.round(amount * 100) / 100 })),
    first_day: days[0] ?? null,
    last_day: days.at(-1) ?? null,
    warnings,
    counts,
  }
}

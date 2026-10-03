// Portfolio value and chart math for the iPhone app. Pure functions, no clock reads.
// Every number comes from the snapshot's real closing prices times the shares you typed in.
// A day where any of your tickers has no price is left out of the line, never filled in.

export interface Quote {
  close: number
  prev_close: number | null
  change_pct: number | null
  day: string
}

export interface History {
  days: string[]
  closes: Record<string, (number | null)[]>
}

export interface Point {
  day: string
  value: number
}

export const RANGES = ['1W', '1M', '3M', 'YTD', '1Y'] as const
export type Range = (typeof RANGES)[number]

/** Dollar value of each holding: shares x last close when we have both, else the dollars typed. */
export function holdingValues(
  shares: Record<string, number>,
  dollars: Record<string, number>,
  quotes: Record<string, Quote>,
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [sym, v] of Object.entries(dollars)) if (v > 0) out[sym] = v
  for (const [sym, n] of Object.entries(shares)) {
    const q = quotes[sym]
    if (n > 0 && q) out[sym] = Math.round(n * q.close * 100) / 100
  }
  return out
}

/** Holdings that can be charted: shares known and a price history for them. */
export function chartable(shares: Record<string, number>, history: History): string[] {
  return Object.keys(shares).filter((s) => (shares[s] ?? 0) > 0 && s in history.closes).sort()
}

/** What the shares you own today were worth at each past close. */
export function valueSeries(shares: Record<string, number>, history: History, symbols = chartable(shares, history)): Point[] {
  if (symbols.length === 0) return []
  const out: Point[] = []
  history.days.forEach((day, i) => {
    let total = 0
    for (const s of symbols) {
      const c = history.closes[s]?.[i]
      if (c === null || c === undefined) return // a gap stays a gap
      total += (shares[s] ?? 0) * c
    }
    out.push({ day, value: Math.round(total * 100) / 100 })
  })
  return out
}

/** One ticker's closes as a line, gaps skipped. */
export function tickerSeries(symbol: string, history: History): Point[] {
  const closes = history.closes[symbol] ?? []
  return history.days.flatMap((day, i) => {
    const c = closes[i]
    return c === null || c === undefined ? [] : [{ day, value: c }]
  })
}

function shift(day: string, months: number, days = 0): string {
  const d = new Date(`${day}T12:00:00Z`)
  const dom = d.getUTCDate()
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() - months)
  // Mar 31 minus a month is the last day of February, not Mar 3.
  const lastDom = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
  d.setUTCDate(Math.min(dom, lastDom))
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString().slice(0, 10)
}

/** First calendar day of a range ending on `last`. */
export function rangeStart(range: Range, last: string): string {
  switch (range) {
    case '1W': return shift(last, 0, 7)
    case '1M': return shift(last, 1)
    case '3M': return shift(last, 3)
    case 'YTD': return `${last.slice(0, 4)}-01-01`
    case '1Y': return shift(last, 12)
  }
}

/** Points in the range. The day before the range starts is the baseline, like "since last close". */
export function inRange(points: Point[], range: Range): { points: Point[]; base: Point | null } {
  const last = points.at(-1)
  if (!last) return { points: [], base: null }
  const start = rangeStart(range, last.day)
  const idx = points.findIndex((p) => p.day >= start)
  if (idx < 0) return { points: [], base: null }
  const base = idx > 0 ? points[idx - 1] ?? null : points[0] ?? null
  return { points: points.slice(idx), base }
}

export function change(now: number, base: number | null): { amount: number | null; pct: number | null } {
  if (base === null) return { amount: null, pct: null }
  return { amount: Math.round((now - base) * 100) / 100, pct: base > 0 ? ((now - base) / base) * 100 : null }
}

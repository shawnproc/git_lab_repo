// "Is the stock sleeve earning its keep?" Your individual stocks vs a shadow portfolio that put
// the same dollars into VTI on the same days. Pure; real closes only; a day any holding lacks a
// price is skipped, and the money that moved since the last counted day is counted on the next.
import { type History, sharesByDay, type ShareChange } from './portfolio'

export interface SleeveResult {
  start_day: string
  end_day: string
  start_value: number // sleeve value on the first day (the shadow starts with the same dollars)
  net_added: number // money put in (+) or taken out (-) after that, at each day's close
  sleeve_value: number
  shadow_value: number
  sleeve_gain: number // value minus everything you put in
  shadow_gain: number
  symbols: string[] // stocks counted
  left_out: string[] // stocks you traded with no price history here
}

export function sleeveVsIndex(trades: ShareChange[], history: History, core: ReadonlySet<string>, benchmark: string): SleeveResult | null {
  const traded = [...new Set(trades.map((t) => t.symbol))].filter((s) => !core.has(s)).sort()
  const symbols = traded.filter((s) => s in history.closes)
  const leftOut = traded.filter((s) => !(s in history.closes))
  const bench = history.closes[benchmark]
  if (symbols.length === 0 || !bench) return null
  const held = Object.fromEntries(symbols.map((s) => [s, sharesByDay(s, trades, history)]))
  const prev: Record<string, number> = {}
  let shadowShares = 0
  let start: { day: string; value: number } | null = null
  let last: { day: string; sleeve: number; shadow: number } | null = null
  let added = 0
  history.days.forEach((day, i) => {
    const b = bench[i]
    if (b === null || b === undefined) return
    let value = 0
    let flow = 0
    for (const s of symbols) {
      const n = held[s]?.[i] ?? 0
      const before = prev[s] ?? 0
      if (n <= 0 && before <= 0) continue
      const c = history.closes[s]?.[i]
      if (c === null || c === undefined) return // a gap: wait for the next day with prices
      value += n * c
      flow += (n - before) * c
    }
    for (const s of symbols) prev[s] = held[s]?.[i] ?? 0
    if (!start) {
      if (value <= 0) return
      start = { day, value }
      shadowShares = value / b
    } else {
      added += flow
      shadowShares += flow / b // same dollars, same day, into the index
    }
    last = { day, sleeve: value, shadow: shadowShares * b }
  })
  const s0 = start as { day: string; value: number } | null
  const l = last as { day: string; sleeve: number; shadow: number } | null
  if (!s0 || !l) return null
  const r2 = (x: number) => Math.round(x * 100) / 100
  const invested = s0.value + added
  return {
    start_day: s0.day,
    end_day: l.day,
    start_value: r2(s0.value),
    net_added: r2(added),
    sleeve_value: r2(l.sleeve),
    shadow_value: r2(Math.max(0, l.shadow)),
    sleeve_gain: r2(l.sleeve - invested),
    shadow_gain: r2(Math.max(0, l.shadow) - invested),
    symbols,
    left_out: leftOut,
  }
}

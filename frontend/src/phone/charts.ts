// Weekly price history for every Search company: charts/<first letter>.json, built each evening
// from the same Yahoo closes as research.json. Public data. A week a company didn't trade is
// null and is skipped, never filled in.
import type { Point } from './portfolio'

const DAY = /^\d{4}-\d{2}-\d{2}$/
const SYMBOL = /^[A-Z0-9]{1,10}(\.[A-Z0-9]{1,4})?$/
const files = new Map<string, Promise<Record<string, Point[]>>>()

/** Validate one letter's file into {SYMBOL: points}. Bad values are dropped. */
export function parseCharts(raw: unknown): Record<string, Point[]> {
  if (typeof raw !== 'object' || raw === null) throw new Error('The chart data looks damaged.')
  const r = raw as Record<string, unknown>
  if (r.schema !== 1 || !Array.isArray(r.days) || typeof r.closes !== 'object' || r.closes === null) throw new Error('The chart data looks damaged.')
  const days = r.days as unknown[]
  if (days.length > 600 || !days.every((d) => typeof d === 'string' && DAY.test(d))) throw new Error('The chart data looks damaged.')
  const out: Record<string, Point[]> = {}
  for (const [sym, row] of Object.entries(r.closes as Record<string, unknown>)) {
    if (!SYMBOL.test(sym) || !Array.isArray(row) || row.length !== days.length) continue
    const pts: Point[] = []
    row.forEach((v, i) => {
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) pts.push({ day: days[i] as string, value: v })
    })
    if (pts.length >= 2) out[sym] = pts
  }
  return out
}

const letterOf = (sym: string) => (/^[A-Z]/.test(sym) ? sym[0] ?? '_' : '_')

/** A company's weekly closes (empty when there's no history). Each letter's file loads once. */
export async function fetchChart(sym: string): Promise<Point[]> {
  if (!SYMBOL.test(sym)) return []
  const letter = letterOf(sym)
  let file = files.get(letter)
  if (!file) {
    file = fetch(`./charts/${letter}.json`, { cache: 'no-cache', credentials: 'omit', redirect: 'error' })
      .then(async (res) => (res.ok ? parseCharts(await res.json()) : {}))
    file.catch(() => files.delete(letter))
    files.set(letter, file)
  }
  return (await file)[sym] ?? []
}

export const resetChartCache = () => { files.clear() }

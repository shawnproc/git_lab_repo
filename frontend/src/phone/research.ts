// The Search tab's data: research.json, a verdict for every US company with over $1B in yearly
// sales, built each weekday from SEC filings and Yahoo closes. Public data only. Pure, except
// fetchResearch.
import type { CheckStatus } from '../api'

export type Verdict = 'fit' | 'pricey' | 'no' | 'unknown' | 'fund'

export const VERDICT_WORDS: Record<Verdict, string> = {
  fit: 'Good fit',
  pricey: 'Good business, pricey right now',
  no: 'Not a fit',
  unknown: 'Not enough data to judge',
  fund: 'Fund',
}

export interface Company {
  s: string // ticker
  n: string // name
  v: Verdict
  h: string // one-sentence reason
  y?: number | null // latest full year in its SEC reports
  rev?: number | null // that year's sales, USD
  close: number | null // last close
  chg: number | null // last day's change, %
  day: string | null // the close's market day
  dy: number | null // dividends over the last year / price, %
  pe?: number | null
  pe_med?: number | null
  pe_flag?: boolean
  pe_note?: string
  checks?: [string, CheckStatus, string][]
}

export interface Research {
  schema: 1
  generated_at: string
  source: string
  min_revenue_usd: number
  companies: Company[]
}

const VERDICTS = new Set<string>(['fit', 'pricey', 'no', 'unknown', 'fund'])
const STATUSES = new Set<string>(['pass', 'fail', 'unavailable'])
const TICKER = /^\^?[A-Z0-9]{1,10}([.-][A-Z0-9]{1,4})?$/
const MAX_COMPANIES = 20_000

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')

/** Validate untrusted JSON field by field. Bad rows are dropped, never repaired. */
export function parseResearch(raw: unknown): Research {
  if (typeof raw !== 'object' || raw === null) throw new Error('The search data looks damaged.')
  const r = raw as Record<string, unknown>
  if (r.schema !== 1 || !Array.isArray(r.companies) || r.companies.length === 0 || r.companies.length > MAX_COMPANIES
    || typeof r.generated_at !== 'string' || Number.isNaN(Date.parse(r.generated_at))) {
    throw new Error('The search data looks damaged.')
  }
  const companies: Company[] = []
  for (const c of r.companies as unknown[]) {
    if (typeof c !== 'object' || c === null) continue
    const o = c as Record<string, unknown>
    if (typeof o.s !== 'string' || !TICKER.test(o.s) || typeof o.v !== 'string' || !VERDICTS.has(o.v)) continue
    const close = num(o.close)
    const checks = Array.isArray(o.checks)
      ? o.checks.filter((x): x is [string, CheckStatus, string] => Array.isArray(x) && x.length === 3
        && typeof x[0] === 'string' && typeof x[1] === 'string' && STATUSES.has(x[1]) && typeof x[2] === 'string')
        .slice(0, 10).map(([a, b, d]) => [a.slice(0, 80), b, d.slice(0, 400)] as [string, CheckStatus, string])
      : undefined
    companies.push({
      s: o.s, n: str(o.n, 120) || o.s, v: o.v as Verdict, h: str(o.h, 400),
      y: num(o.y), rev: num(o.rev),
      close: close !== null && close > 0 ? close : null,
      chg: num(o.chg), day: typeof o.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.day) ? o.day : null,
      dy: num(o.dy), pe: num(o.pe), pe_med: num(o.pe_med), pe_flag: o.pe_flag === true, pe_note: str(o.pe_note, 400),
      ...(checks ? { checks } : {}),
    })
  }
  if (companies.length === 0) throw new Error('The search data looks damaged.')
  return {
    schema: 1, generated_at: r.generated_at, source: str(r.source, 200),
    min_revenue_usd: num(r.min_revenue_usd) ?? 0, companies,
  }
}

export async function fetchResearch(): Promise<Research> {
  const res = await fetch('./research.json', { cache: 'no-cache', credentials: 'omit', redirect: 'error' })
  if (!res.ok) throw new Error('Search data isn’t available yet. It’s built by the evening update.')
  return parseResearch(await res.json())
}

const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9.\- ]/g, '').replace(/\s+/g, ' ').trim()

/** Best matches first: exact ticker, ticker prefix, name word prefix, then name contains. */
export function searchCompanies(list: Company[], query: string, limit = 20): Company[] {
  const q = norm(query).slice(0, 40)
  if (!q) return []
  const qt = q.replace(/-/g, '.')
  const scored: [number, Company][] = []
  for (const c of list) {
    const name = norm(c.n)
    let score = -1
    if (c.s === qt) score = 0
    else if (c.s.startsWith(qt)) score = 1
    else if (name.startsWith(q)) score = 2
    else if (name.split(' ').some((w) => w.startsWith(q))) score = 3
    else if (q.length >= 3 && name.includes(q)) score = 4
    if (score >= 0) scored.push([score, c])
  }
  scored.sort((a, b) => a[0] - b[0] || (b[1].rev ?? 0) - (a[1].rev ?? 0) || (a[1].s < b[1].s ? -1 : 1))
  return scored.slice(0, limit).map(([, c]) => c)
}

/** "$394 billion" style, for yearly sales. */
export function fmtBig(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  const short = (x: number, d: number) => String(Number(x.toFixed(d)))
  if (n >= 1e12) return `$${short(n / 1e12, 1)} trillion`
  if (n >= 1e9) return `$${short(n / 1e9, n >= 1e10 ? 0 : 1)} billion`
  return `$${(n / 1e6).toFixed(0)} million`
}

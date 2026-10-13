// dossier.json: insider trades (SEC Form 4) and big-event filings (SEC Form 8-K) for every
// Search company, built each evening. Public data. Pure, except fetchDossier.

export type TradeCode = 'P' | 'S'
/** [day, insider, role, P|S, shares, dollars, 1 if under a pre-set 10b5-1 plan] */
export type Trade = [string, string, string, TradeCode, number, number, 0 | 1]
/** [day filed, item codes "2.02,5.02", EDGAR path] */
export type Event8K = [string, string, string]

export interface Dossier {
  generated_at: string
  window_days: number
  days: string[] // filing days read so far (the history fills in over the first weeks)
  companies: Record<string, { t: Trade[]; e: Event8K[] }>
}

const DAY = /^\d{4}-\d{2}-\d{2}$/
const TICKER = /^[A-Z]{1,5}(\.[A-Z])?$/
const PATH = /^edgar\/data\/\d{1,10}\/[\d-]{20}\.txt$/
const fin = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max

/** Validate untrusted JSON row by row; damaged rows are dropped, never repaired. */
export function parseDossier(raw: unknown): Dossier {
  if (typeof raw !== 'object' || raw === null) throw new Error('The insider data looks damaged.')
  const r = raw as Record<string, unknown>
  if (r.schema !== 1 || typeof r.generated_at !== 'string' || !Array.isArray(r.days) || typeof r.companies !== 'object' || r.companies === null) {
    throw new Error('The insider data looks damaged.')
  }
  const companies: Dossier['companies'] = {}
  for (const [sym, c] of Object.entries(r.companies as Record<string, unknown>)) {
    if (!TICKER.test(sym) || typeof c !== 'object' || c === null) continue
    const { t, e } = c as Record<string, unknown>
    const trades = (Array.isArray(t) ? t : []).filter((x): x is Trade => Array.isArray(x) && x.length === 7
      && typeof x[0] === 'string' && DAY.test(x[0]) && typeof x[1] === 'string' && typeof x[2] === 'string'
      && (x[3] === 'P' || x[3] === 'S') && fin(x[4], 1e12) && fin(x[5], 1e12) && (x[6] === 0 || x[6] === 1))
      .slice(0, 30).map((x) => [x[0], x[1].slice(0, 60), x[2].slice(0, 60), x[3], x[4], x[5], x[6]] as Trade)
    const events = (Array.isArray(e) ? e : []).filter((x): x is Event8K => Array.isArray(x) && x.length === 3
      && typeof x[0] === 'string' && DAY.test(x[0]) && typeof x[1] === 'string' && /^[\d.,]{1,80}$/.test(x[1])
      && typeof x[2] === 'string' && PATH.test(x[2])).slice(0, 15)
    if (trades.length || events.length) companies[sym] = { t: trades, e: events }
  }
  return {
    generated_at: r.generated_at,
    window_days: typeof r.window_days === 'number' ? r.window_days : 90,
    days: r.days.filter((d): d is string => typeof d === 'string' && DAY.test(d)),
    companies,
  }
}

let cached: Promise<Dossier> | null = null
export const resetDossierCache = () => { cached = null }
/** Loaded once, the first time a screen needs it (it's a big file). */
export function fetchDossier(): Promise<Dossier> {
  cached ??= fetch('./dossier.json', { cache: 'no-cache', credentials: 'omit', redirect: 'error' })
    .then(async (res) => {
      if (!res.ok) throw new Error('Insider and event data isn’t published yet. It’s built by the evening update.')
      return parseDossier(await res.json())
    })
    .catch((e: unknown) => { cached = null; throw e })
  return cached
}

export interface InsiderSummary {
  buys: number // open-market purchases
  buyers: number // different insiders who bought
  bought: number // dollars
  sold: number // dollars sold, all
  soldUnplanned: number // dollars sold outside a pre-set plan
  cluster: boolean // 2+ different insiders bought within 30 days of each other
}

const dayNum = (d: string) => Date.parse(`${d}T00:00:00Z`) / 86_400_000

export function summarize(trades: Trade[]): InsiderSummary {
  const buys = trades.filter((t) => t[3] === 'P')
  const sells = trades.filter((t) => t[3] === 'S')
  let cluster = false
  for (const a of buys) {
    if (buys.some((b) => b[1] !== a[1] && Math.abs(dayNum(a[0]) - dayNum(b[0])) <= 30)) { cluster = true; break }
  }
  const sum = (xs: Trade[]) => Math.round(xs.reduce((s, t) => s + t[5], 0))
  return {
    buys: buys.length,
    buyers: new Set(buys.map((t) => t[1])).size,
    bought: sum(buys),
    sold: sum(sells),
    soldUnplanned: sum(sells.filter((t) => t[6] === 0)),
    cluster,
  }
}

export type Tone = 'red' | 'watch' | 'info'

/** What each 8-K item means, in plain words, and how much attention it usually deserves. */
export const EVENT_WORDS: Record<string, [string, Tone]> = {
  '1.01': ['Signed a major agreement (a big contract, deal or partnership)', 'info'],
  '1.02': ['Ended a major agreement', 'watch'],
  '1.03': ['Filed for bankruptcy or receivership', 'red'],
  '1.05': ['Reported a serious cybersecurity incident', 'red'],
  '2.01': ['Finished buying or selling a business or big assets', 'info'],
  '2.02': ['Released quarterly or yearly results', 'info'],
  '2.03': ['Took on significant new debt', 'watch'],
  '2.04': ['Something made its debt come due sooner or grow', 'red'],
  '2.05': ['Announced closings, layoffs or restructuring costs', 'watch'],
  '2.06': ['Wrote down the value of something it owns (an impairment)', 'red'],
  '3.01': ['Got a warning it may be removed from its stock exchange', 'red'],
  '3.02': ['Sold new shares privately (your slice can shrink)', 'watch'],
  '3.03': ['Changed shareholders’ rights', 'watch'],
  '4.01': ['Changed its outside auditor', 'red'],
  '4.02': ['Said past financial statements can’t be relied on', 'red'],
  '5.01': ['A change in who controls the company', 'watch'],
  '5.02': ['Leadership change (an executive or director left or joined)', 'watch'],
  '5.03': ['Changed its bylaws or fiscal year', 'info'],
  '5.07': ['Reported the results of a shareholder vote', 'info'],
  '7.01': ['Shared information publicly (often a presentation or press release)', 'info'],
  '8.01': ['Other news the company chose to report', 'info'],
}

export const filingLink = (path: string) => {
  const m = /^edgar\/data\/(\d+)\/([\d-]+)\.txt$/.exec(path)
  return m ? `https://www.sec.gov/Archives/edgar/data/${m[1] ?? ''}/${(m[2] ?? '').replace(/-/g, '')}/${m[2] ?? ''}-index.htm` : null
}

/** Company size from its market value (price x shares). */
export function sizeWord(mcap: number | null | undefined): string | null {
  if (mcap === null || mcap === undefined) return null
  if (mcap < 300e6) return 'Micro-cap: tiny, thinly traded, the wildest swings'
  if (mcap < 2e9) return 'Small-cap: lesser known, big swings'
  if (mcap < 10e9) return 'Mid-cap'
  if (mcap < 200e9) return 'Large-cap'
  return 'Mega-cap: one of the biggest companies in the world'
}

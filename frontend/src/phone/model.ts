// The public snapshot's shape and the helpers every screen shares. No personal data here.
import type { Learn, MoodResult, ScreenResult } from '../api'
import { buildTargets, type CoreFund, type DriftRules, type PlanTarget } from './logic'
import type { History, Quote } from './portfolio'
import { freshness, type Freshness, type RefreshStatus, type Session } from './stale'
import type { Research } from './research'
import type { PhoneData } from './store'

export interface Section {
  source: string
  fetched_at: string | null
  stale: boolean
  reason: string
  last_error: string
}

export interface Valuation {
  pe: number | null
  median_pe: number | null
  years_used: number[]
  eps_year: number | null
  flagged: boolean
  detail: string
}

export type Trend = 'improving' | 'steady' | 'weakening' | 'new' | 'search'
export type WatchStatus = 'ok' | 'watch' | 'replace'

export interface SnapTarget extends PlanTarget {
  base_pct?: number // core funds: configured weight
  weight?: number // stocks: affinity (1 = an equal share)
  trend?: Trend
  status?: WatchStatus
  affinity_reason?: string
  valuation?: Valuation
}

export interface Snapshot {
  schema: 1
  generated_at: string
  mood: Section & { result: MoodResult; index_day: string | null; vix_day: string | null }
  plan: Section & { targets: SnapTarget[]; screen: ScreenResult[]; watch?: Record<string, WatchStatus>; quarter?: string }
  /** Optional: older snapshots don't have these. */
  prices?: Section & { quotes: Record<string, Quote>; history?: History; missing: string[] }
  overlap?: { fund: string; top: { symbol: string; weight_pct: number }[]; source: string; fetched_at: string | null; error: string }
  sessions?: Session[]
  rules: { drift: DriftRules; core_pct?: number; stocks_pct?: number; max_single_stock_pct?: number; core_funds?: CoreFund[] }
  learn: Learn
}

/** Search picks you switched on for your buy days that are still a "Good fit" today (and not
 * already plan picks). Without today's search data, none are added: never on an old verdict. */
export function includedPicks(snap: Snapshot, data: PhoneData, research: Research | null): SnapTarget[] {
  if (!research) return []
  const inPlan = new Set(snap.plan.targets.map((t) => t.symbol))
  const by = new Map(research.companies.map((c) => [c.s, c]))
  return data.watchlist.filter((w) => w.include && !inPlan.has(w.symbol) && by.get(w.symbol)?.v === 'fit').map((w) => {
    const c = by.get(w.symbol)
    return { symbol: w.symbol, name: c?.n ?? w.symbol, kind: 'stock' as const, target_pct: 0, weight: 1, trend: 'search' as const, why: 'Your pick from Search. It passes every quality check.' }
  })
}

/** Targets under your chosen funds/stocks split (default: the plan's), plus your included
 * Search picks. Every stock stays under the per-company cap. */
export function targetsFor(snap: Snapshot, data: PhoneData, research: Research | null = null): SnapTarget[] {
  const funds = snap.rules.core_funds
  const cap = snap.rules.max_single_stock_pct
  if (!funds || funds.length === 0 || cap === undefined) return snap.plan.targets // older snapshot
  const core = snap.plan.targets.filter((t) => t.kind === 'core')
  const stocks = [...snap.plan.targets.filter((t) => t.kind === 'stock'), ...includedPicks(snap, data, research)]
  const corePct = data.core_pct ?? snap.rules.core_pct ?? 60
  return buildTargets(core, funds, stocks, 100 - corePct, cap)
}

/** Holdings that get no new buy-day money right now (price well above its usual level). */
export function skipFor(targets: SnapTarget[]): Set<string> {
  return new Set(targets.filter((t) => t.valuation?.flagged).map((t) => t.symbol))
}

export function freshnessOf(snap: Snapshot, status: RefreshStatus | null, now = new Date()): Freshness {
  const quotes = snap.prices?.quotes ?? {}
  const days = snap.plan.targets.map((t) => quotes[t.symbol]?.day ?? null)
  return freshness(days, snap.sessions, status, now)
}

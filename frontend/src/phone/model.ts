// The public snapshot's shape and the helpers every screen shares. No personal data here.
import type { Learn, MoodResult, ScreenResult } from '../api'
import { buildTargets, type CoreFund, type DriftRules, type PlanTarget } from './logic'
import type { History, Quote } from './portfolio'
import { freshness, type Freshness, type RefreshStatus, type Session } from './stale'
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

export type Trend = 'improving' | 'steady' | 'weakening' | 'new'
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

/** Targets under your chosen funds/stocks split (default: the plan's). */
export function targetsFor(snap: Snapshot, data: PhoneData): SnapTarget[] {
  const funds = snap.rules.core_funds
  const cap = snap.rules.max_single_stock_pct
  if (!funds || funds.length === 0 || cap === undefined) return snap.plan.targets // older snapshot
  const core = snap.plan.targets.filter((t) => t.kind === 'core')
  const stocks = snap.plan.targets.filter((t) => t.kind === 'stock')
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

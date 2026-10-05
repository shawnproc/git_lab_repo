// Plan math for the iPhone app. These are TypeScript ports of the tested Python engine
// (backend/src/keystone_ledger/core/plan.py and core/wall.py); tests use the same numbers.
import type { Course, DriftRow, Stone, StoneState, Wall } from '../api'

export interface PlanTarget {
  symbol: string
  name: string
  kind: 'core' | 'stock'
  target_pct: number
  why: string
}

export interface DriftRules {
  max_abs_pp: number
  max_relative_pct: number
}

/** Holdings on the phone are dollar values you type in from your broker app. */
export function drift(targets: PlanTarget[], values: Record<string, number>, rules: DriftRules): DriftRow[] {
  const total = Object.values(values).reduce((a, v) => a + v, 0)
  const rows: DriftRow[] = []
  for (const t of targets) {
    const actual = values[t.symbol] ?? 0
    const targetValue = (t.target_pct / 100) * total
    if (total <= 0) {
      rows.push({ symbol: t.symbol, kind: t.kind, target_pct: t.target_pct, actual_pct: null, diff_pp: null,
        target_value: targetValue, actual_value: actual, flagged: false, reason: '' })
      continue
    }
    const actualPct = (actual / total) * 100
    const diff = actualPct - t.target_pct
    const rel = t.target_pct > 0 ? (Math.abs(diff) / t.target_pct) * 100 : 0
    const offAbs = Math.abs(diff) > rules.max_abs_pp
    const offRel = rel > rules.max_relative_pct
    let reason = ''
    if (actual === 0) reason = "you don't own any yet"
    else if (offAbs || offRel) {
      reason = `${Math.abs(diff).toFixed(1)} percentage points ${diff > 0 ? 'above' : 'below'} its target`
      if (offRel) reason += ` (about ${rel.toFixed(0)}% ${diff > 0 ? 'more' : 'less'} than planned)`
    }
    rows.push({ symbol: t.symbol, kind: t.kind, target_pct: t.target_pct, actual_pct: actualPct, diff_pp: diff,
      target_value: targetValue, actual_value: actual, flagged: offAbs || offRel, reason })
  }
  const inPlan = new Set(targets.map((t) => t.symbol))
  for (const [symbol, v] of Object.entries(values)) {
    if (inPlan.has(symbol)) continue
    const pct = total > 0 ? (v / total) * 100 : null
    rows.push({ symbol, kind: 'off_plan', target_pct: 0, actual_pct: pct, diff_pp: pct, target_value: 0,
      actual_value: v, flagged: true, reason: "not part of your plan (that's okay; it just isn't counted toward a target)" })
  }
  return rows
}

export interface DollarSplit {
  symbol: string
  amount: number
}

/** New money goes to whatever is furthest below target first. Never suggests selling.
 * Dollars only: at the broker you buy "in dollars", so no share prices are needed.
 * `skip` (price-flagged holdings) gets no new money this time; it goes to the next most-behind
 * holdings instead. If everything would be skipped, nothing is. Mirrors split_contribution. */
export function splitContribution(amount: number, allTargets: PlanTarget[], values: Record<string, number>, skip: ReadonlySet<string> = new Set()): { allocations: DollarSplit[]; leftover: number } {
  if (amount <= 0 || allTargets.length === 0) return { allocations: [], leftover: amount }
  const eligible = allTargets.filter((t) => !skip.has(t.symbol))
  const targets = eligible.length > 0 ? eligible : allTargets
  const total = Object.values(values).reduce((a, v) => a + v, 0)
  const newTotal = total + amount
  const deficits = new Map(targets.map((t) => [t.symbol, Math.max(0, (t.target_pct / 100) * newTotal - (values[t.symbol] ?? 0))]))
  const totalDef = [...deficits.values()].reduce((a, v) => a + v, 0)
  const dollars = new Map<string, number>()
  if (totalDef >= amount) {
    for (const [s, d] of deficits) dollars.set(s, (amount * d) / totalDef)
  } else {
    const rest = amount - totalDef
    const weightSum = targets.reduce((a, t) => a + t.target_pct, 0)
    for (const t of targets) dollars.set(t.symbol, (deficits.get(t.symbol) ?? 0) + (rest * t.target_pct) / weightSum)
  }
  const allocations = [...dollars].filter(([, d]) => d >= 0.005).map(([symbol, d]) => ({ symbol, amount: Math.round(d * 100) / 100 }))
  // Rounding each buy to the cent can drift by a cent or two; give the difference to the biggest
  // buy so the split always adds up to exactly what you typed.
  const cents = Math.round(amount * 100) - allocations.reduce((a, x) => a + Math.round(x.amount * 100), 0)
  const biggest = allocations.reduce<DollarSplit | undefined>((m, x) => (!m || x.amount > m.amount ? x : m), undefined)
  if (biggest && cents !== 0) biggest.amount = (Math.round(biggest.amount * 100) + cents) / 100
  return { allocations, leftover: 0 }
}

// --- targets (mirror of core/plan.py build_targets / sleeve_weights) ---------------------

/** Split `total` in proportion to `weights`, no share above `cap`; a capped share's excess is
 * shared among the uncapped ones. Only if every share is capped is anything left over. */
export function sleeveWeights(total: number, weights: number[], cap: number): number[] {
  const out = weights.map(() => 0)
  let free = weights.map((_, i) => i).filter((i) => (weights[i] ?? 0) > 0)
  let remaining = total
  while (free.length > 0 && remaining > 1e-12) {
    const wsum = free.reduce((a, i) => a + (weights[i] ?? 0), 0)
    const trial = new Map(free.map((i) => [i, (remaining * (weights[i] ?? 0)) / wsum]))
    const over = free.filter((i) => (out[i] ?? 0) + (trial.get(i) ?? 0) > cap + 1e-12)
    if (over.length === 0) {
      for (const i of free) out[i] = (out[i] ?? 0) + (trial.get(i) ?? 0)
      remaining = 0
      break
    }
    for (const i of over) {
      remaining -= cap - (out[i] ?? 0)
      out[i] = cap
    }
    free = free.filter((i) => !over.includes(i))
  }
  return out
}

export interface CoreFund { symbol: string; weight_pct: number }

/** Core funds share `100 - stocksPct` in their configured proportions; stocks share `stocksPct`
 * by weight, each capped. Always sums to 100%. */
export function buildTargets<T extends PlanTarget & { weight?: number }>(core: (PlanTarget & { base_pct?: number })[], coreFunds: CoreFund[], stocks: T[], stocksPct: number, cap: number): (PlanTarget | T)[] {
  const shares = sleeveWeights(stocksPct, stocks.map((s) => s.weight ?? 1), cap)
  const coreTotal = 100 - shares.reduce((a, x) => a + x, 0)
  const coreSum = coreFunds.reduce((a, f) => a + f.weight_pct, 0)
  const byCore = new Map(core.map((c) => [c.symbol, c]))
  const out: (PlanTarget | T)[] = coreFunds.map((f) => {
    const c = byCore.get(f.symbol)
    return { symbol: f.symbol, name: c?.name ?? f.symbol, kind: 'core' as const, why: c?.why ?? '', target_pct: (coreTotal * f.weight_pct) / coreSum }
  })
  stocks.forEach((s, i) => out.push({ ...s, target_pct: shares[i] ?? 0 }))
  return out
}

// --- the growing wall ---------------------------------------------------------------------

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

export interface Entry {
  id: string
  month: string // "2026-10"
  amount: number
  note: string
  created_at: string
}

const idx = (m: string) => {
  const [y, mo] = m.split('-').map(Number)
  return (y ?? 0) * 12 + ((mo ?? 1) - 1)
}
const fromIdx = (i: number) => `${String(Math.floor(i / 12))}-${String((i % 12) + 1).padStart(2, '0')}`
const pl = (n: number) => `${String(n)} month${n === 1 ? '' : 's'}`

export function buildWall(entries: Entry[], thisMonth: string): Wall {
  const now = idx(thisMonth)
  const totals = new Map<number, number>()
  const counts = new Map<number, number>()
  for (const e of entries) {
    const i = idx(e.month)
    if (i > now) continue
    totals.set(i, (totals.get(i) ?? 0) + e.amount)
    counts.set(i, (counts.get(i) ?? 0) + 1)
  }
  const laid = [...totals.keys()].sort((a, b) => a - b)
  const first = laid[0]
  let longest = 0
  let run = 0
  let prev: number | undefined
  for (const m of laid) {
    run = prev !== undefined && m - prev === 1 ? run + 1 : 1
    longest = Math.max(longest, run)
    prev = m
  }
  const thisLaid = totals.has(now)
  let cursor = thisLaid ? now : now - 1
  let current = 0
  while (totals.has(cursor)) {
    current++
    cursor--
  }
  const thisYear = Math.floor(now / 12)
  const firstYear = first !== undefined ? Math.floor(first / 12) : thisYear
  const courses: Course[] = []
  for (let year = thisYear; year >= firstYear; year--) {
    const stones: Stone[] = MONTHS.map((name, mi) => {
      const i = year * 12 + mi
      let state: StoneState
      if (totals.has(i)) state = 'laid'
      else if (i > now) state = 'future'
      else if (i === now) state = 'open'
      else if (first !== undefined && i < first) state = 'before_start'
      else state = 'missed'
      return { month: `${fromIdx(i)}-01`, label: `${name} ${String(year)}`, state,
        amount: Math.round((totals.get(i) ?? 0) * 100) / 100, entries: counts.get(i) ?? 0 }
    })
    const n = stones.filter((s) => s.state === 'laid').length
    courses.push({ year, stones, laid: n, keystone: n === 12, total: Math.round(stones.reduce((a, s) => a + s.amount, 0) * 100) / 100 })
  }
  const yearComplete = courses[0]?.keystone ?? false
  let message: string
  if (laid.length === 0) message = 'Your wall is empty. Lay your first stone the next time you invest.'
  else if (!thisLaid) message = current > 0 ? `You've laid ${pl(current)} in a row. Invest this month to keep the streak going.` : 'No stone yet this month. Every month you invest adds one.'
  else if (yearComplete) message = `A full year! This row now has its keystone. ${pl(current)} in a row.`
  else message = `This month's stone is laid. ${pl(current)} in a row. Nicely done.`
  return {
    courses,
    total: Math.round([...totals.values()].reduce((a, v) => a + v, 0) * 100) / 100,
    months_laid: laid.length,
    current_streak: current,
    longest_streak: longest,
    first_month: first !== undefined ? `${fromIdx(first)}-01` : null,
    this_month: `${thisMonth}-01`,
    this_month_laid: thisLaid,
    keystones: courses.filter((c) => c.keystone).length,
    message,
  }
}

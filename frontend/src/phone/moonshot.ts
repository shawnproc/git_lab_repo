// The Moonshot side: small, high-risk bets kept apart from the long-term plan. Pure functions.
// The guardrails are code, not advice: the app refuses to log a bet that breaks them.
//   1. A risk budget: moonshots may hold at most `budget_pct`% of everything you have
//      (you pick 1-10%; 10% is a hard ceiling no setting can raise).
//   2. No single bet over a quarter of that budget, so one blow-up can't take it all.
//   3. Money is never moved from the plan's side: the budget only measures, it never sells.

export const MAX_BUDGET_PCT = 10
export const DEFAULT_BUDGET_PCT = 5
export const MAX_BET_SHARE = 0.25 // of the moonshot budget
export const MAX_BETS = 20

export type BetKind = 'stock' | 'private'

export interface MoonBet {
  id: string
  symbol: string // a ticker, or a short name for a private company
  kind: BetKind
  shares: number
  cost: number // dollars you paid in total (incl. fees)
  bought: string // YYYY-MM-DD
  /** Private companies have no market price: the last value you typed in (and when). */
  value?: number | null
  value_at?: string | null
}

export interface Moonshot {
  budget_pct: number
  ack_at: string | null // when you accepted the risk checklist
  bets: MoonBet[]
}

export const emptyMoonshot = (): Moonshot => ({ budget_pct: DEFAULT_BUDGET_PCT, ack_at: null, bets: [] })

export const invested = (m: Moonshot) => Math.round(m.bets.reduce((a, b) => a + b.cost, 0) * 100) / 100

export interface Budget {
  total: number // what you have: the plan's side + what you put into moonshots
  budget: number // the most moonshots may hold
  used: number // what you've put in (at cost)
  room: number // what's left for new bets (never below 0)
  perBet: number // the most for any one bet
}

/** `planValue`: what your long-term holdings are worth. Bets count at cost, so a lucky run-up
 * never "earns" you more room to bet with. */
export function budgetOf(m: Moonshot, planValue: number): Budget {
  const used = invested(m)
  const total = Math.max(0, planValue) + used
  const pct = Math.min(Math.max(m.budget_pct, 1), MAX_BUDGET_PCT)
  const budget = (total * pct) / 100
  const r = (n: number) => Math.round(n * 100) / 100
  return { total: r(total), budget: r(budget), used, room: r(Math.max(0, budget - used)), perBet: r(budget * MAX_BET_SHARE) }
}

/** Why a new bet of `amount` dollars would break a guardrail (empty = allowed). */
export function betProblems(m: Moonshot, planValue: number, amount: number, symbol: string): string[] {
  const b = budgetOf(m, planValue)
  const out: string[] = []
  if (!m.ack_at) out.push('Accept the risk checklist first.')
  if (!(amount > 0)) out.push('Type what you paid, in dollars.')
  if (m.bets.length >= MAX_BETS) out.push(`You already have ${String(MAX_BETS)} bets. Close one before adding another.`)
  if (planValue <= 0) out.push('Add your long-term holdings on the Steady side first: the budget is a share of everything you have.')
  if (amount > b.room + 0.005) out.push(`That's over your moonshot budget. You have $${b.room.toFixed(2)} of room left (${String(m.budget_pct)}% of everything).`)
  const already = m.bets.filter((x) => x.symbol === symbol).reduce((a, x) => a + x.cost, 0)
  if (already + amount > b.perBet + 0.005) out.push(`One bet can be at most a quarter of your budget: $${b.perBet.toFixed(2)} in total for ${symbol}.`)
  return out
}

/** 3.2 means it's worth 3.2x what you paid. Null when there's no price. */
export function multiple(bet: MoonBet, price: number | null): number | null {
  const now = bet.kind === 'private' ? (bet.value ?? null) : price === null ? null : price * bet.shares
  return now === null || bet.cost <= 0 ? null : now / bet.cost
}

/** A plain note for where a bet stands. Teaches; never tells you to buy or sell. */
export function milestone(x: number | null): string | null {
  if (x === null) return null
  if (x >= 10) return 'Up more than 10x. Gains this size can vanish as fast as they came. Many people take some money off the table, but check the tax first (Sell & taxes tab).'
  if (x >= 2) return 'It has doubled. One common rule: sell just enough to get your original money back, so what stays in is “house money”. The Sell & taxes tab shows how many shares and the tax.'
  if (x <= 0.5) return 'Down by half or more. A guardrail: the app won’t let you add past the per-bet limit to “win it back”. Most bets that fall this far don’t come back.'
  return null
}

const SYMBOL = /^[A-Z0-9][A-Z0-9 .&-]{0,23}$/
const DAY = /^(19\d\d|20\d\d)-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown, max: number) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max

/** Validate untrusted JSON (storage or a backup). Throws a plain-English error. */
export function parseMoonshot(raw: unknown): Moonshot {
  if (raw === undefined) return emptyMoonshot()
  if (!isObj(raw)) throw new Error('The backup’s moonshot bets are damaged.')
  const { budget_pct, ack_at, bets } = raw
  if (typeof budget_pct !== 'number' || !Number.isInteger(budget_pct) || budget_pct < 1 || budget_pct > MAX_BUDGET_PCT) throw new Error('The backup’s moonshot budget is damaged.')
  if (ack_at !== null && (typeof ack_at !== 'string' || Number.isNaN(Date.parse(ack_at)))) throw new Error('The backup’s moonshot checklist date is damaged.')
  if (!Array.isArray(bets) || bets.length > MAX_BETS) throw new Error('The backup’s moonshot bets are damaged.')
  const out: MoonBet[] = bets.map((b: unknown) => {
    if (!isObj(b)) throw new Error('The backup has a damaged moonshot bet.')
    const { id, symbol, kind, shares, cost, bought, value, value_at } = b
    if (typeof id !== 'string' || id.length > 64 || typeof symbol !== 'string' || !SYMBOL.test(symbol)
      || (kind !== 'stock' && kind !== 'private') || !num(shares, 1e12) || !num(cost, 1e9) || (cost as number) <= 0
      || typeof bought !== 'string' || !DAY.test(bought)
      || (value !== undefined && value !== null && !num(value, 1e12))
      || (value_at !== undefined && value_at !== null && (typeof value_at !== 'string' || !DAY.test(value_at)))) {
      throw new Error('The backup has a damaged moonshot bet.')
    }
    return { id, symbol, kind, shares: shares as number, cost: cost as number, bought, value: (value as number | null | undefined) ?? null, value_at: (value_at) ?? null }
  })
  return { budget_pct, ack_at: ack_at, bets: out }
}

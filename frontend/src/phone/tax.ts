// What selling a stock could cost in US federal tax. Pure: no clock reads, no I/O.
// An ESTIMATE for learning, not tax advice: federal only (no state), and it assumes your only
// deduction is the standard deduction and that this sale is your only capital gain or loss.
//
// Every number below is from IRS Rev. Proc. 2025-32 (tax year 2026). Head of household is left
// out on purpose: published copies disagree on two of its cutoffs, and we never guess a number.

export type FilingStatus = 'single' | 'mfj'

export const TAX_YEAR = 2026
export const TAX_SOURCE = 'IRS Rev. Proc. 2025-32 (2026 inflation adjustments)'
export const TAX_SOURCE_URL = 'https://www.irs.gov/pub/irs-drop/rp-25-32.pdf'

export const FILING_WORDS: Record<FilingStatus, string> = { single: 'Single', mfj: 'Married filing jointly' }

interface Table {
  standardDeduction: number
  /** Upper edge of each ordinary bracket (taxable income), lowest first; the last is open. */
  brackets: { upTo: number; rate: number }[]
  /** Long-term gains: 0% while taxable income stays at or under `zeroUpTo`, 15% to `fifteenUpTo`, then 20%. */
  zeroUpTo: number
  fifteenUpTo: number
  /** Net investment income tax (3.8%) applies above this income. Fixed in the law, not indexed. */
  niitOver: number
}

export const TABLES: Record<FilingStatus, Table> = {
  single: {
    standardDeduction: 16_100,
    brackets: [
      { upTo: 12_400, rate: 0.1 }, { upTo: 50_400, rate: 0.12 }, { upTo: 105_700, rate: 0.22 },
      { upTo: 201_775, rate: 0.24 }, { upTo: 256_225, rate: 0.32 }, { upTo: 640_600, rate: 0.35 },
      { upTo: Infinity, rate: 0.37 },
    ],
    zeroUpTo: 49_450,
    fifteenUpTo: 545_500,
    niitOver: 200_000,
  },
  mfj: {
    standardDeduction: 32_200,
    brackets: [
      { upTo: 24_800, rate: 0.1 }, { upTo: 100_800, rate: 0.12 }, { upTo: 211_400, rate: 0.22 },
      { upTo: 403_550, rate: 0.24 }, { upTo: 512_450, rate: 0.32 }, { upTo: 768_700, rate: 0.35 },
      { upTo: Infinity, rate: 0.37 },
    ],
    zeroUpTo: 98_900,
    fifteenUpTo: 613_700,
    niitOver: 250_000,
  },
}

/** A loss can lower your other income by at most this much a year; the rest carries forward. */
export const LOSS_LIMIT = 3_000
const NIIT_RATE = 0.038

/** Tax on ordinary taxable income, bracket by bracket. */
export function ordinaryTax(taxable: number, status: FilingStatus): number {
  let tax = 0
  let lower = 0
  for (const b of TABLES[status].brackets) {
    if (taxable <= lower) break
    tax += (Math.min(taxable, b.upTo) - lower) * b.rate
    lower = b.upTo
  }
  return tax
}

/** Your top bracket: the rate on your next dollar of ordinary income. */
export function marginalRate(taxable: number, status: FilingStatus): number {
  for (const b of TABLES[status].brackets) if (taxable < b.upTo) return b.rate
  return 0.37
}

/** Long-term gain tax: the gain sits on top of your other taxable income. */
function longTermTax(otherTaxable: number, gain: number, t: Table): number {
  const bands: [number, number, number][] = [[0, t.zeroUpTo, 0], [t.zeroUpTo, t.fifteenUpTo, 0.15], [t.fifteenUpTo, Infinity, 0.2]]
  let tax = 0
  for (const [lo, hi, rate] of bands) {
    const from = Math.max(lo, otherTaxable)
    const to = Math.min(hi, otherTaxable + gain)
    if (to > from) tax += (to - from) * rate
  }
  return tax
}

/** The day a holding becomes long-term: held MORE than one year, so the day after the 1-year
 * anniversary of the buy. Dates are "YYYY-MM-DD". Feb 29 buys count from Mar 1. */
export function longTermFrom(bought: string): string {
  const [y, m, d] = bought.split('-').map(Number) as [number, number, number]
  const anniversary = new Date(Date.UTC(y + 1, m - 1, d))
  if (anniversary.getUTCMonth() !== m - 1) anniversary.setUTCDate(0) // Feb 29 -> Feb 28 next year
  anniversary.setUTCDate(anniversary.getUTCDate() + 1)
  return anniversary.toISOString().slice(0, 10)
}

export interface SaleInput {
  status: FilingStatus
  income: number // your yearly income before taxes, not counting this sale
  proceeds: number // what the sale brings in (shares x sell price)
  basis: number // what you paid for those shares (incl. fees)
  bought: string // YYYY-MM-DD
  sold: string // YYYY-MM-DD
}

export interface SaleEstimate {
  gain: number // negative = loss
  longTerm: boolean
  longTermFrom: string
  daysHeld: number
  federalTax: number // extra federal tax from this sale (negative = it lowers your tax)
  niit: number
  rate: number // federalTax / gain, when there's a gain
  keep: number // proceeds minus the tax
  ifLongTerm: number | null // the tax if you waited until it's long-term (only for short-term gains)
  carryForward: number // loss you can't use this year; it rolls into next year
}

const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)

function gainTax(status: FilingStatus, income: number, gain: number, longTerm: boolean): { tax: number; niit: number } {
  const t = TABLES[status]
  const other = Math.max(0, income - t.standardDeduction)
  if (gain <= 0) {
    const used = Math.min(-gain, LOSS_LIMIT)
    return { tax: -(ordinaryTax(other, status) - ordinaryTax(Math.max(0, other - used), status)), niit: 0 }
  }
  const tax = longTerm ? longTermTax(other, gain, t) : ordinaryTax(other + gain, status) - ordinaryTax(other, status)
  // Simplified: income stands in for the "modified adjusted gross income" the 3.8% tax uses.
  const niit = NIIT_RATE * Math.max(0, Math.min(gain, income + gain - t.niitOver))
  return { tax: tax + niit, niit }
}

export function estimateSale(s: SaleInput): SaleEstimate {
  const gain = Math.round((s.proceeds - s.basis) * 100) / 100
  const from = longTermFrom(s.bought)
  const longTerm = s.sold >= from
  const { tax, niit } = gainTax(s.status, s.income, gain, longTerm)
  const ifLong = !longTerm && gain > 0 ? Math.round(gainTax(s.status, s.income, gain, true).tax * 100) / 100 : null
  const federalTax = Math.round(tax * 100) / 100
  return {
    gain,
    longTerm,
    longTermFrom: from,
    daysHeld: days(s.bought, s.sold),
    federalTax,
    niit: Math.round(niit * 100) / 100,
    rate: gain > 0 ? federalTax / gain : 0,
    keep: Math.round((s.proceeds - Math.max(0, federalTax)) * 100) / 100,
    ifLongTerm: ifLong,
    carryForward: gain < 0 ? Math.max(0, -gain - LOSS_LIMIT) : 0,
  }
}

/** Shares to sell to take your original money back out (before tax), leaving the rest "free". */
export function sharesToRecoverCost(shares: number, costPerShare: number, price: number): number | null {
  if (price <= costPerShare || shares <= 0) return null // not up: there's no "house money" yet
  return Math.round(((shares * costPerShare) / price) * 1e4) / 1e4
}

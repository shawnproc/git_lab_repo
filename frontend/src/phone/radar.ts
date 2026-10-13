// The Moonshot radar: two lists built only from companies' own SEC numbers. Pure.
// It doesn't predict prices. It surfaces what the reports already show, before most people look:
//   Under the radar: smaller companies whose sales are growing fast and whose profits are improving.
//   Warning signs: household names whose sales are shrinking or whose profit per $1 is falling.
import type { Company } from './research'

export const SMALL_MAX = 5e9 // yearly sales: at or under this is "not a household name" here
export const BIG_MIN = 20e9 // at or over this, most people know the brand
export const FAST_GROWTH = 25 // % a year over 3 years
export const MARGIN_DROP = 3 // points of profit per $1 of sales, over two years

export interface RadarRow { c: Company; why: string; score: number }

const n = (x: number | null | undefined): x is number => typeof x === 'number' && Number.isFinite(x)
const pts = (x: number) => `${x.toFixed(1)}¢`

export function underTheRadar(list: Company[], limit = 25): RadarRow[] {
  const out: RadarRow[] = []
  for (const c of list) {
    if (c.v === 'fund' || !n(c.rev) || c.rev > SMALL_MAX || !n(c.g3) || c.g3 < FAST_GROWTH) continue
    const improving = n(c.om) && n(c.om0) && c.om > c.om0
    const cash = n(c.fcfm) && c.fcfm > 0
    if (!improving && !cash) continue // growth that only burns cash is a coin flip
    const bits = [`sales up about ${c.g3.toFixed(0)}% a year`]
    if (improving && n(c.om) && n(c.om0)) bits.push(`profit per $1 of sales up from ${pts(c.om0)} to ${pts(c.om)}`)
    if (cash && n(c.fcfm)) bits.push(`keeps ${pts(c.fcfm)} in cash per $1`)
    out.push({ c, why: bits.join(', '), score: c.g3 + (improving ? 5 : 0) })
  }
  return out.sort((a, b) => b.score - a.score || (a.c.s < b.c.s ? -1 : 1)).slice(0, limit)
}

export function warningSigns(list: Company[], limit = 25): RadarRow[] {
  const out: RadarRow[] = []
  for (const c of list) {
    if (c.v === 'fund' || !n(c.rev) || c.rev < BIG_MIN) continue
    const shrinking = n(c.g1) && c.g1 < 0
    const drop = n(c.om) && n(c.om0) ? c.om0 - c.om : 0
    if (!shrinking && drop < MARGIN_DROP) continue
    const bits: string[] = []
    if (shrinking && n(c.g1)) bits.push(`sales fell ${Math.abs(c.g1).toFixed(1)}% last year`)
    if (drop >= MARGIN_DROP && n(c.om) && n(c.om0)) bits.push(`profit per $1 of sales down from ${pts(c.om0)} to ${pts(c.om)}`)
    out.push({ c, why: bits.join(', '), score: Math.max(0, -(c.g1 ?? 0)) + Math.max(0, drop) })
  }
  return out.sort((a, b) => b.score - a.score || (a.c.s < b.c.s ? -1 : 1)).slice(0, limit)
}

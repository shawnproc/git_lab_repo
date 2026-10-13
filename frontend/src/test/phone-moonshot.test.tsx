import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { betProblems, budgetOf, emptyMoonshot, milestone, type Moonshot, multiple, parseMoonshot } from '../phone/moonshot'
import PhoneApp, { type Snapshot } from '../phone/PhoneApp'
import { empty, parseData } from '../phone/store'
import { estimateSale, longTermFrom, ordinaryTax, sharesToRecoverCost } from '../phone/tax'
import { learn } from './fixtures'

vi.mock('lightweight-charts', () => ({
  createChart: () => ({
    addSeries: () => ({ setData: () => undefined, createPriceLine: () => undefined }),
    timeScale: () => ({ fitContent: () => undefined }),
    subscribeCrosshairMove: () => undefined,
    unsubscribeCrosshairMove: () => undefined,
    remove: () => undefined,
  }),
  LineSeries: {},
  CrosshairMode: { Magnet: 1 },
  LineStyle: { Solid: 0, Dotted: 1 },
  TrackingModeExitMode: { OnTouchEnd: 1 },
}))

const sale = { status: 'single' as const, bought: '2026-01-05', sold: '2026-10-13' }

describe('stock-sale taxes (2026, IRS Rev. Proc. 2025-32)', () => {
  it('uses the published brackets', () => {
    expect(ordinaryTax(12_400, 'single')).toBeCloseTo(1_240)
    expect(ordinaryTax(50_400, 'single')).toBeCloseTo(5_800) // 1,240 + 12% of 38,000
    expect(ordinaryTax(24_800, 'mfj')).toBeCloseTo(2_480)
  })

  it('short-term gains pay your regular rate; long-term can be 0%', () => {
    // $60k income -> $43,900 taxable after the $16,100 standard deduction: the 12% bracket.
    const st = estimateSale({ ...sale, income: 60_000, proceeds: 2_000, basis: 1_000 })
    expect(st.longTerm).toBe(false)
    expect(st.federalTax).toBeCloseTo(120)
    expect(st.ifLongTerm).toBe(0) // still under the $49,450 0% line once long-term
    expect(st.longTermFrom).toBe('2027-01-06')
    const lt = estimateSale({ ...sale, bought: '2025-01-05', income: 60_000, proceeds: 2_000, basis: 1_000 })
    expect(lt.longTerm).toBe(true)
    expect(lt.federalTax).toBe(0)
  })

  it('stacks gains on top of income, and adds the 3.8% for high earners', () => {
    const st = estimateSale({ ...sale, income: 100_000, proceeds: 20_000, basis: 10_000 })
    expect(st.federalTax).toBeCloseTo(2_200) // all in the 22% bracket
    expect(st.ifLongTerm).toBeCloseTo(1_500) // 15%
    const rich = estimateSale({ ...sale, bought: '2024-06-01', income: 250_000, proceeds: 200_000, basis: 100_000 })
    expect(rich.niit).toBeCloseTo(3_800)
    expect(rich.federalTax).toBeCloseTo(18_800) // 15% x 100k + 3.8% x 100k
    expect(rich.keep).toBeCloseTo(181_200)
  })

  it('a 16x gain is real money and real tax', () => {
    const x16 = estimateSale({ ...sale, income: 60_000, proceeds: 1_600, basis: 100 })
    expect(x16.gain).toBe(1_500)
    expect(x16.federalTax).toBeCloseTo(180) // 12%, short-term
  })

  it('losses lower tax up to $3,000 a year and carry the rest forward', () => {
    const loss = estimateSale({ ...sale, income: 60_000, proceeds: 1_000, basis: 6_000 })
    expect(loss.gain).toBe(-5_000)
    expect(loss.federalTax).toBeCloseTo(-360) // $3,000 at 12%
    expect(loss.carryForward).toBe(2_000)
  })

  it('long-term starts the day after the one-year anniversary', () => {
    expect(longTermFrom('2025-10-13')).toBe('2026-10-14')
    expect(longTermFrom('2024-02-29')).toBe('2025-03-01')
    expect(sharesToRecoverCost(10, 10, 40)).toBe(2.5) // $100 back out at $40 a share
    expect(sharesToRecoverCost(10, 10, 9)).toBeNull() // not up: nothing to take off the table
  })
})

const ready = (bets: Moonshot['bets'] = [], pct = 5): Moonshot => ({ budget_pct: pct, ack_at: '2026-10-01T00:00:00Z', bets })
const bet = (symbol: string, cost: number, shares = 10) => ({ id: symbol + String(cost), symbol, kind: 'stock' as const, shares, cost, bought: '2026-09-01', value: null, value_at: null })

describe('moonshot guardrails', () => {
  it('sizes the budget from everything you have, counting bets at cost', () => {
    expect(budgetOf(ready([bet('PLTR', 500)]), 9_500)).toEqual({ total: 10_000, budget: 500, used: 500, room: 0, perBet: 125 })
    expect(budgetOf({ ...ready(), budget_pct: 99 }, 10_000).budget).toBe(1_000) // never past 10%
  })

  it('refuses bets that break a limit, and says why', () => {
    expect(betProblems(emptyMoonshot(), 10_000, 100, 'ABC')).toContain('Accept the risk checklist first.')
    expect(betProblems(ready(), 10_000, 100, 'ABC')).toEqual([]) // $500 budget, $125 per bet
    expect(betProblems(ready(), 10_000, 200, 'ABC').join(' ')).toMatch(/at most a quarter/)
    expect(betProblems(ready([bet('A', 125), bet('B', 125), bet('C', 125)]), 10_000, 125, 'D')).toEqual([])
    expect(betProblems(ready([bet('A', 125), bet('B', 125), bet('C', 125), bet('D', 125)]), 10_000, 30, 'E').join(' ')).toMatch(/over your moonshot budget/) // $525 budget, $25 left
    expect(betProblems(ready([bet('A', 100)]), 10_000, 50, 'A').join(' ')).toMatch(/quarter/) // adding to a loser counts too
    expect(betProblems(ready(), 0, 10, 'A').join(' ')).toMatch(/long-term holdings/)
  })

  it('reads multiples and milestones without telling you to trade', () => {
    expect(multiple(bet('A', 100, 10), 160)).toBe(16)
    expect(milestone(16)).toMatch(/10x/)
    expect(milestone(2.1)).toMatch(/original money back/)
    expect(milestone(0.4)).toMatch(/won’t let you add/)
    expect(milestone(1.2)).toBeNull()
  })

  it('validates saved bets and old backups', () => {
    expect(parseData({ ...empty(), moonshot: undefined }).moonshot.bets).toEqual([]) // older backups
    expect(() => parseMoonshot({ budget_pct: 11, ack_at: null, bets: [] })).toThrow()
    expect(() => parseMoonshot({ budget_pct: 5, ack_at: null, bets: [{ ...bet('A', 100), cost: -1 }] })).toThrow()
    expect(() => parseMoonshot({ budget_pct: 5, ack_at: null, bets: [{ ...bet('<script>', 100) }] })).toThrow()
    expect(parseMoonshot(ready([bet('A', 100)])).bets).toHaveLength(1)
  })
})

const snapshot: Snapshot = {
  schema: 1,
  generated_at: new Date().toISOString(),
  mood: { result: { mood: 'green', headline: 'Calm.', reasons: [], index_close: 1, index_ma: 1, vix: 14 }, source: 'FRED', index_day: '2026-10-01', vix_day: '2026-10-01', fetched_at: new Date().toISOString(), stale: false, reason: '', last_error: '' },
  plan: { targets: [{ symbol: 'VTI', name: 'Total US', kind: 'core', target_pct: 100, why: '' }], screen: [], source: 'sec', fetched_at: new Date().toISOString(), stale: false, reason: '', last_error: '' },
  prices: { quotes: { VTI: { close: 300, prev_close: 299, change_pct: 0.3, day: '2026-10-12' }, PLTR: { close: 40, prev_close: 39, change_pct: 2.5, day: '2026-10-12' } }, history: { days: [], closes: {} }, missing: [], source: 'yfinance', fetched_at: new Date().toISOString(), stale: false, reason: '', last_error: '' },
  sessions: [{ day: '2026-10-12', close: '2026-10-12T20:00:00+00:00' }, { day: '2099-01-02', close: '2099-01-02T21:00:00+00:00' }],
  rules: { drift: { max_abs_pp: 5, max_relative_pct: 25 } },
  learn,
}

function start(hash: string) {
  window.location.hash = hash
  vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(url.endsWith('snapshot.json') ? new Response(JSON.stringify(snapshot), { status: 200 }) : new Response('', { status: 404 }))))
  render(<PhoneApp />)
}

describe('Moonshot side', () => {
  beforeEach(() => { localStorage.clear() })
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.location.hash = '' })

  it('starts behind a risk checklist, then enforces the budget when logging a bet', async () => {
    localStorage.setItem('keystone.phone.v1', JSON.stringify({ ...empty(), shares: { VTI: 33 } })) // $9,900 in the plan
    start('#/moon')
    const go = await screen.findByRole('button', { name: /I understand/ })
    expect(go).toBeDisabled()
    for (const box of screen.getAllByRole('checkbox')) fireEvent.click(box)
    fireEvent.click(go)
    expect(await screen.findByText('Your risk budget')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Bets/ })).toBeInTheDocument() // the Moonshot dock
    expect(screen.queryByRole('link', { name: 'Invest' })).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Ticker'), { target: { value: 'pltr' } })
    fireEvent.change(screen.getByLabelText('Dollars paid'), { target: { value: '400' } })
    fireEvent.change(screen.getByLabelText('Shares'), { target: { value: '10' } })
    fireEvent.click(screen.getByRole('button', { name: /log it/ }))
    expect(await screen.findByText(/One bet can be at most a quarter/)).toBeInTheDocument() // $495 budget, $123.75 per bet
    fireEvent.change(screen.getByLabelText('Dollars paid'), { target: { value: '100' } })
    fireEvent.change(screen.getByLabelText('Shares'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: /log it/ }))
    expect(await screen.findByText('2.00x')).toBeInTheDocument() // 5 x $40 last close vs $100 paid
    expect(screen.getByText(/It has doubled/)).toBeInTheDocument()
    const saved = parseData(JSON.parse(localStorage.getItem('keystone.phone.v1') ?? '{}'))
    expect(saved.moonshot.bets).toEqual([expect.objectContaining({ symbol: 'PLTR', cost: 100, shares: 5 })])
    expect(saved.shares).toEqual({ VTI: 33 }) // the plan's side is untouched
  })

  it('Sell & taxes estimates the bill and the long-term saving', async () => {
    const today = new Date()
    const bought = new Date(today.getFullYear(), today.getMonth() - 2, 1)
    const day = `${String(bought.getFullYear())}-${String(bought.getMonth() + 1).padStart(2, '0')}-01`
    localStorage.setItem('keystone.phone.v1', JSON.stringify({ ...empty(), moonshot: ready([{ ...bet('PLTR', 100, 5), bought: day }]) }))
    start('#/sell')
    expect(await screen.findByText(/Short-term/)).toBeInTheDocument()
    expect(screen.getByText('$200.00')).toBeInTheDocument() // you'd get 5 x $40
    expect(screen.getAllByText('$12.00')).toHaveLength(2) // the tax (12% of a $100 gain on $60k income) and the saving if long-term (0%)
    expect(screen.getByText(/If you waited until/)).toBeInTheDocument()
    expect(screen.getByText(/sell about/)).toBeInTheDocument() // shares to take the $100 back out
    expect(screen.getByText(/Estimate only, not tax advice/)).toBeInTheDocument()
  })
})

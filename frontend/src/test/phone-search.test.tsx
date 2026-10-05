import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchLiveQuote, LiveError, type LiveRound, liveValueSeries, parseQuote, validKey } from '../phone/live'
import { includedPicks, type Snapshot, targetsFor } from '../phone/model'
import PhoneApp from '../phone/PhoneApp'
import { parseResearch, type Research, searchCompanies } from '../phone/research'
import { empty, MAX_INCLUDED, parseData, type PhoneData } from '../phone/store'
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

const checks: [string, 'pass' | 'fail' | 'unavailable', string][] = [
  ['Growing sales', 'pass', 'Sales grew 8% a year.'],
  ['Keeps a good share of each sale', 'pass', '$1 of sales keeps 31¢.'],
  ['Brings in real cash', 'pass', 'Yes.'],
  ['Debt it can handle', 'pass', 'Yes.'],
  ['Getting more profitable', 'pass', 'Yes.'],
]

const research: Research = {
  schema: 1,
  generated_at: '2026-10-02T22:40:00+00:00',
  source: 'SEC EDGAR frames + yfinance',
  min_revenue_usd: 1e9,
  companies: [
    { s: 'AAPL', n: 'Apple Inc.', v: 'fit', h: 'It passes every quality check and its price looks normal for it.', y: 2025, rev: 416e9, close: 255.5, chg: 1.2, day: '2026-10-02', dy: 0.41, pe: 33.1, pe_med: 28, pe_flag: false, pe_note: 'It costs about $33 per $1 of yearly profit, near or below its usual $28.', checks },
    { s: 'APA', n: 'APA Corp', v: 'no', h: 'It doesn’t pass “Growing sales”.', y: 2025, rev: 9e9, close: 22, chg: -0.5, day: '2026-10-02', dy: 4.5, checks },
    { s: 'NVDA', n: 'NVIDIA Corp', v: 'pricey', h: 'It passes every quality check, but its price is well above its usual level.', y: 2025, rev: 130e9, close: 180, chg: 2, day: '2026-10-02', dy: null, pe_flag: true, checks },
    { s: 'BRK.B', n: 'Berkshire Hathaway Inc', v: 'fit', h: 'ok', rev: 370e9, close: 480, chg: 0, day: '2026-10-02', dy: null },
    { s: 'VTI', n: 'VTI', v: 'fund', h: 'A fund.', close: 312.5, chg: 0.8, day: '2026-10-02', dy: 1.2 },
  ],
}

const snapshot: Snapshot = {
  schema: 1,
  generated_at: new Date().toISOString(),
  mood: {
    result: { mood: 'green', headline: 'Calm.', reasons: [], index_close: 6500, index_ma: 6000, vix: 14 },
    source: 'FRED', index_day: '2026-10-01', vix_day: '2026-10-01', fetched_at: new Date().toISOString(), stale: false, reason: '', last_error: '',
  },
  plan: {
    targets: [
      { symbol: 'VTI', name: 'Total US', kind: 'core', target_pct: 45, why: '' },
      { symbol: 'VXUS', name: 'Total intl', kind: 'core', target_pct: 15, why: '' },
      { symbol: 'MSFT', name: 'Microsoft', kind: 'stock', target_pct: 8, why: '', weight: 1 },
    ],
    screen: [], source: 'sec_edgar', fetched_at: new Date().toISOString(), stale: false, reason: '', last_error: '',
  },
  prices: {
    quotes: { VTI: { close: 312.5, prev_close: 310, change_pct: 0.8, day: '2026-10-02' } },
    history: { days: [], closes: {} }, missing: [], source: 'yfinance', fetched_at: new Date().toISOString(), stale: false, reason: '', last_error: '',
  },
  sessions: [{ day: '2026-10-02', close: '2026-10-02T20:00:00+00:00' }, { day: '2099-01-02', close: '2099-01-02T21:00:00+00:00' }],
  rules: { drift: { max_abs_pp: 5, max_relative_pct: 25 }, core_pct: 60, stocks_pct: 40, max_single_stock_pct: 8,
    core_funds: [{ symbol: 'VTI', weight_pct: 45 }, { symbol: 'VXUS', weight_pct: 15 }] },
  learn,
}

const withWatch = (items: PhoneData['watchlist']): PhoneData => ({ ...empty(), watchlist: items })
const item = (symbol: string, include = false, verdict = 'fit') => ({ symbol, added_at: '2026-09-01T15:00:00.000Z', added_price: 200, verdict_at_add: verdict, include })

describe('search data', () => {
  it('validates field by field and drops bad rows instead of fixing them', () => {
    const r = parseResearch({ ...research, companies: [...research.companies, { s: '<img>', v: 'fit' }, { s: 'ZZ', v: 'buy' }, { s: 'BAD', v: 'fit', close: -3, h: 1 }] })
    expect(r.companies.map((c) => c.s)).toEqual(['AAPL', 'APA', 'NVDA', 'BRK.B', 'VTI', 'BAD'])
    expect(r.companies.at(-1)?.close).toBeNull() // a broken price is absent, never $0
    expect(() => parseResearch({ schema: 1, generated_at: 'x', companies: [] })).toThrow()
    expect(() => parseResearch(snapshot)).toThrow() // the snapshot is not search data
  })

  it('finds by ticker first, then by name', () => {
    const list = research.companies
    expect(searchCompanies(list, 'aapl')[0]?.s).toBe('AAPL')
    expect(searchCompanies(list, 'apple')[0]?.s).toBe('AAPL')
    expect(searchCompanies(list, 'AP').map((c) => c.s)).toEqual(['APA', 'AAPL']) // ticker prefix beats a name match
    expect(searchCompanies(list, 'brk-b')[0]?.s).toBe('BRK.B')
    expect(searchCompanies(list, 'hathaway')[0]?.s).toBe('BRK.B')
    expect(searchCompanies(list, '   ')).toEqual([])
  })
})

describe('watchlist', () => {
  it('is validated on load and restore', () => {
    expect(parseData({ ...empty(), watchlist: [item('AAPL')] }).watchlist).toHaveLength(1)
    expect(parseData({ version: 1, holdings: {}, values_as_of: null, entries: [] }).watchlist).toEqual([]) // older backups
    expect(() => parseData({ ...empty(), watchlist: [item('AAPL'), item('AAPL')] })).toThrow()
    expect(() => parseData({ ...empty(), watchlist: [{ ...item('AAPL'), verdict_at_add: 'moon' }] })).toThrow()
    expect(() => parseData({ ...empty(), watchlist: [{ ...item('AAPL'), added_price: -1 }] })).toThrow()
    const many = ['A', 'B', 'C', 'D', 'E', 'F'].map((s) => item(s, true))
    expect(many.length).toBeGreaterThan(MAX_INCLUDED)
    expect(() => parseData({ ...empty(), watchlist: many })).toThrow()
  })

  it('adds included Good fits to buy days, under the cap, and pauses them otherwise', () => {
    const data = withWatch([item('AAPL', true), item('NVDA', true), item('APA', false)])
    expect(includedPicks(snapshot, data, research).map((t) => t.symbol)).toEqual(['AAPL']) // NVDA is pricey now
    expect(includedPicks(snapshot, data, null)).toEqual([]) // no search data today: never an old verdict
    const t = targetsFor(snapshot, data, research)
    const stocks = t.filter((x) => x.kind === 'stock')
    expect(stocks.map((x) => x.symbol)).toEqual(['MSFT', 'AAPL'])
    expect(Math.max(...stocks.map((x) => x.target_pct))).toBeLessThanOrEqual(8)
    expect(t.reduce((a, x) => a + x.target_pct, 0)).toBeCloseTo(100)
  })
})

describe('live prices', () => {
  it('accepts only sane quotes', () => {
    const now = Date.parse('2026-10-05T15:00:00Z')
    const q = parseQuote({ c: 257, pc: 255, t: now / 1000 - 30 }, now)
    expect(q?.price).toBe(257)
    expect(q?.change_pct).toBeCloseTo(0.784, 2)
    expect(parseQuote({ c: 0, d: null, dp: null, h: 0, l: 0, o: 0, pc: 0, t: 0 }, now)).toBeNull() // unknown symbol
    expect(parseQuote({ c: 257, pc: 255, t: now / 1000 + 3600 }, now)).toBeNull() // from the future
    expect(parseQuote('nope', now)).toBeNull()
  })

  it('checks the key and says plainly when it is refused', async () => {
    expect(validKey('abcd1234efgh5678ijkl')).toBe(true)
    expect(validKey('abc')).toBe(false)
    expect(validKey('abcd1234efgh5678ijkl&x=1')).toBe(false)
    const spy = vi.fn(() => Promise.resolve(new Response('{}', { status: 401 })))
    vi.stubGlobal('fetch', spy)
    await expect(fetchLiveQuote('AAPL', 'abcd1234efgh5678ijkl')).rejects.toBeInstanceOf(LiveError)
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url.startsWith('https://finnhub.io/api/v1/quote?symbol=AAPL&token=')).toBe(true)
    expect(init.credentials).toBe('omit')
    expect(init.referrerPolicy).toBe('no-referrer')
    expect(await fetchLiveQuote('../x', 'abcd1234efgh5678ijkl')).toBeNull() // never sent
    expect(spy).toHaveBeenCalledTimes(1)
  })
})

function start(hash: string, files: Record<string, unknown>) {
  window.location.hash = hash
  const spy = vi.fn((url: string) => {
    const name = url.split('/').pop() ?? ''
    return Promise.resolve(name in files ? new Response(JSON.stringify(files[name]), { status: 200 }) : new Response('', { status: 404 }))
  })
  vi.stubGlobal('fetch', spy)
  render(<PhoneApp />)
  return spy
}

describe('Search tab', () => {
  beforeEach(() => { localStorage.clear() })
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.location.hash = '' })

  it('search Apple -> verdict and reasons -> watchlist -> include in buy days', async () => {
    const spy = start('#/search', { 'snapshot.json': snapshot, 'research.json': research })
    fireEvent.change(await screen.findByLabelText('Company or ticker'), { target: { value: 'apple' } })
    fireEvent.click(await screen.findByRole('button', { name: /AAPL/ }))
    expect(screen.getAllByText('Good fit').length).toBeGreaterThan(0)
    expect(screen.getByText(/passes every quality check and its price looks normal/)).toBeInTheDocument()
    expect(screen.getByText(/\$416 billion/)).toBeInTheDocument()
    expect(screen.getByText(/At the close on Oct 2, 2026/)).toBeInTheDocument() // never called live without a key
    fireEvent.click(screen.getByRole('button', { name: 'Add AAPL to my watchlist' }))
    fireEvent.click(screen.getByLabelText('Include in my buy days'))
    const saved = JSON.parse(localStorage.getItem('keystone.phone.v1') ?? '{}') as PhoneData
    expect(saved.watchlist).toEqual([expect.objectContaining({ symbol: 'AAPL', added_price: 255.5, verdict_at_add: 'fit', include: true })])
    expect(spy.mock.calls.every((c) => /\/(snapshot|status|research)\.json$/.test(c[0]))).toBe(true) // no key: no live calls
  })

  it('shows a verdict change and pauses a pick that is no longer a fit', async () => {
    localStorage.setItem('keystone.phone.v1', JSON.stringify(withWatch([item('APA', true, 'fit')])))
    start('#/search', { 'snapshot.json': snapshot, 'research.json': research })
    expect(await screen.findByText(/Changed: it was “Good fit”/)).toBeInTheDocument()
    expect(screen.getByText(/Paused: it’s no longer a “Good fit”/)).toBeInTheDocument()
    expect(screen.getByLabelText('Include in my buy days')).toBeDisabled()
    expect(screen.getByText('−89.00% since added')).toBeInTheDocument() // $22 vs $200
  })

  it('says so when the search data is missing', async () => {
    start('#/search', { 'snapshot.json': snapshot })
    expect(await screen.findByText(/Search data isn’t available yet/)).toBeInTheDocument()
  })
})

describe('live prices on Today', () => {
  beforeEach(() => { localStorage.clear() })
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.location.hash = '' })

  it('values your shares this minute and shows the key works', async () => {
    localStorage.setItem('keystone.live.v1', 'abcd1234efgh5678ijkl')
    localStorage.setItem('keystone.phone.v1', JSON.stringify({ ...empty(), shares: { VTI: 2 } }))
    const t = Math.floor(Date.now() / 1000) - 30
    window.location.hash = '#/today'
    const spy = vi.fn((url: string) => {
      if (url.startsWith('https://finnhub.io/')) return Promise.resolve(new Response(JSON.stringify({ c: 320, pc: 312.5, t }), { status: 200 }))
      const name = url.split('/').pop() ?? ''
      const files: Record<string, unknown> = { 'snapshot.json': snapshot, 'research.json': research }
      return Promise.resolve(name in files ? new Response(JSON.stringify(files[name]), { status: 200 }) : new Response('', { status: 404 }))
    })
    vi.stubGlobal('fetch', spy)
    render(<PhoneApp />)
    expect(await screen.findByText('$640.00')).toBeInTheDocument() // 2 x $320 live
    expect(screen.getByText(/\+\$15\.00/)).toBeInTheDocument() // vs 2 x $312.50 at the close
    const live = spy.mock.calls.map((c) => c[0]).filter((u) => u.startsWith('https://finnhub.io/'))
    expect(live[0]).toContain('symbol=VTI') // what you own is looked up first
  })

  it('builds the day line from real fetched prices only', () => {
    const rounds: LiveRound[] = [{ at: 'a', prices: { VTI: 320 } }, { at: 'b', prices: { VTI: 321, NEW: 10 } }]
    expect(liveValueSeries({ VTI: 2, VXUS: 1 }, { VXUS: 70 }, rounds).map((p) => p.value)).toEqual([710, 712])
    expect(liveValueSeries({ ZZZ: 1 }, {}, rounds)).toEqual([]) // nothing priced: no line, not $0
  })
})

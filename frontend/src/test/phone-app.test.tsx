import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PhoneApp, { type Snapshot } from '../phone/PhoneApp'
import { learn, plan } from './fixtures'

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

const snapshot: Snapshot = {
  schema: 1,
  generated_at: new Date().toISOString(),
  mood: {
    result: { mood: 'green', headline: 'Calm and rising. Business as usual: keep adding money on your normal schedule.', reasons: ['Direction: up.', 'Nerves: calm.'], index_close: 6500, index_ma: 6000, vix: 14 },
    source: 'FRED (SP500, VIXCLS)', index_day: '2026-10-01', vix_day: '2026-10-01', fetched_at: new Date().toISOString(), stale: false, reason: '', last_error: '',
  },
  plan: {
    targets: plan.targets.map(({ symbol, name, kind, target_pct, why }) => ({ symbol, name, kind, target_pct, why })),
    screen: plan.screen, source: 'sec_edgar', fetched_at: new Date().toISOString(), stale: false, reason: '', last_error: '',
  },
  prices: {
    quotes: {
      VTI: { close: 312.5, prev_close: 310, change_pct: 0.8065, day: '2026-10-02' },
      VXUS: { close: 70, prev_close: 71, change_pct: -1.4085, day: '2026-10-02' },
    },
    history: {
      days: ['2026-09-30', '2026-10-01', '2026-10-02'],
      closes: { VTI: [300, 310, 312.5], VXUS: [72, 71, 70] },
    },
    missing: ['MSFT'], source: 'yfinance', fetched_at: new Date().toISOString(), stale: true, reason: 'no price for MSFT', last_error: 'MSFT: yfinance: no data',
  },
  rules: { drift: { max_abs_pp: 5, max_relative_pct: 25 } },
  learn,
}

function start(hash: string, snap: Snapshot = snapshot) {
  window.location.hash = hash
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify(snap), { status: 200 }))))
  render(<PhoneApp />)
}

beforeEach(() => { localStorage.clear() })
afterEach(() => { vi.unstubAllGlobals(); window.location.hash = '' })

describe('iPhone app', () => {
  it('Today shows the mood and a big invest button, with no login', async () => {
    start('#/today')
    expect(await screen.findByText('Green')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Invest this month/ })).toHaveAttribute('href', '#/invest')
    expect(screen.queryByText(/Sign in/)).not.toBeInTheDocument()
    for (const label of ['Today', 'Invest', 'Plan', 'Wall', 'Learn']) expect(screen.getByRole('link', { name: label })).toBeInTheDocument()
  })

  it('warns loudly when the snapshot is stale', async () => {
    start('#/today', { ...snapshot, mood: { ...snapshot.mood, stale: true, reason: 'Today’s update failed, showing the last good data. (fred: HTTP 503)' } })
    expect(await screen.findByText(/Some numbers are old/)).toBeInTheDocument()
    expect(screen.getByText(/fred: HTTP 503/)).toBeInTheDocument()
  })

  it('invest flow: values -> split -> lay the stone, all saved on the phone only', async () => {
    const fetchSpy = vi.fn(() => Promise.resolve(new Response(JSON.stringify(snapshot), { status: 200 })))
    window.location.hash = '#/invest'
    vi.stubGlobal('fetch', fetchSpy)
    render(<PhoneApp />)
    fireEvent.change(await screen.findByLabelText('VTI shares'), { target: { value: '3.2' } })
    expect(screen.getByText('≈ $1,000.00')).toBeInTheDocument() // 3.2 x $312.50
    expect(screen.getByLabelText('MSFT value in dollars')).toBeInTheDocument() // no price, so dollars
    fireEvent.click(screen.getByRole('button', { name: 'Save values' }))
    expect(screen.getByText('✓ Saved on this phone')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Split it' }))
    expect(screen.getAllByText(/^Buy/).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: /I invested \$500.00\. Lay the stone/ }))
    expect(await screen.findByText(/Stone laid for/)).toBeInTheDocument()
    const saved = JSON.parse(localStorage.getItem('keystone.phone.v1') ?? '{}') as { holdings: Record<string, number>; shares: Record<string, number>; entries: unknown[] }
    expect(saved.entries).toHaveLength(1)
    // VTI was already over its target, so the money went to the underweight holdings instead.
    expect(saved.shares.VTI).toBe(3.2)
    expect(saved.shares.VXUS).toBeGreaterThan(0) // priced: tracked as (estimated) shares
    expect(saved.holdings.MSFT).toBeGreaterThan(0) // no price: tracked as dollars
    // Nothing personal was ever sent anywhere: the only request was the public snapshot.
    expect(fetchSpy.mock.calls.every((c) => String((c as unknown[])[0]).endsWith('snapshot.json'))).toBe(true)
  })

  it('Today lists each plan ticker with its last close, and never invents a missing one', async () => {
    start('#/today')
    expect(await screen.findByText('$312.50')).toBeInTheDocument()
    expect(screen.getByText('+0.81%')).toBeInTheDocument()
    expect(screen.getByText('−1.41%')).toBeInTheDocument()
    expect(screen.getByText('no price today')).toBeInTheDocument() // MSFT
    expect(screen.getByText(/Ticker prices: no price for MSFT/)).toBeInTheDocument()
  })

  it('works with an older snapshot that has no prices', async () => {
    const old: Snapshot = { ...snapshot }
    delete old.prices
    start('#/today', old)
    expect(await screen.findByText('Green')).toBeInTheDocument()
    expect(screen.getAllByText('no price today')).toHaveLength(3)
  })

  it('split shows estimated shares at the last close', async () => {
    start('#/invest')
    fireEvent.click(await screen.findByRole('button', { name: 'Split it' }))
    // No values yet, so the split follows the targets: VTI gets 45% of $500 = $225.
    expect(screen.getByText('≈ 0.72 shares at the last close of $312.50')).toBeInTheDocument()
  })

  it('Today shows your money as a big number with a chart and time ranges', async () => {
    localStorage.setItem('keystone.phone.v1', JSON.stringify({ version: 1, holdings: { ZZZ: 40 }, shares: { VTI: 2, VXUS: 10 }, values_as_of: null, entries: [] }))
    start('#/today')
    // 2 x 312.50 + 10 x 70 = 1,325.00; the 1Y range starts at the first close: 2 x 300 + 10 x 72 = 1,320
    expect(await screen.findByText('$1,325.00')).toBeInTheDocument()
    expect(screen.getByText('+$5.00 (+0.38%)')).toBeInTheDocument()
    expect(screen.getAllByTestId('value-chart')).toHaveLength(1)
    for (const r of ['1W', '1M', '3M', 'YTD', '1Y']) expect(screen.getByRole('button', { name: r })).toBeInTheDocument()
    expect(screen.getByText(/Not on the line: ZZZ/)).toBeInTheDocument()
    expect(screen.getByText('$1,365.00')).toBeInTheDocument() // everything together
  })

  it('Today without shares invites you to add them', async () => {
    start('#/today')
    expect(await screen.findByRole('link', { name: /Add my shares/ })).toHaveAttribute('href', '#/invest')
  })

  it('tapping a ticker opens its chart', async () => {
    start('#/today')
    fireEvent.click(await screen.findByRole('button', { name: /VTI/ }))
    expect(screen.getByText('VTI price')).toBeInTheDocument()
    expect(screen.getAllByTestId('value-chart')).toHaveLength(1)
    expect(screen.getByRole('button', { name: /MSFT/ })).toBeDisabled() // no price, no chart
  })

  it('imports a Robinhood report: preview, then real shares, history and stones', async () => {
    const csv = [
      '"Activity Date","Process Date","Settle Date","Instrument","Description","Trans Code","Quantity","Price","Amount"',
      '"10/1/2026","10/1/2026","10/2/2026","VXUS","Vanguard Total Intl","Buy","5","$71.00","($355.00)"',
      '"9/30/2026","9/30/2026","10/1/2026","VTI","Vanguard Total Stock Market","Buy","2","$300.00","($600.00)"',
      '"","","","","The data provided is for informational purposes only.","","","",""',
    ].join('\n')
    start('#/invest')
    const input = await screen.findByLabelText('Robinhood activity report file')
    fireEvent.change(input, { target: { files: [new File([csv], 'report.csv', { type: 'text/csv' })] } })
    expect(await screen.findByText(/Found 2 buys and 0 sells/)).toBeInTheDocument()
    expect(screen.getByText('≈ $625.00')).toBeInTheDocument() // 2 VTI x $312.50
    fireEvent.click(screen.getByRole('button', { name: 'Use these' }))
    expect(await screen.findByText(/Imported 2 holdings and 2 months of stones/)).toBeInTheDocument()
    expect(screen.getByLabelText('VTI shares')).toHaveValue('2')
    const saved = JSON.parse(localStorage.getItem('keystone.phone.v1') ?? '{}') as { shares: Record<string, number>; trades: unknown[]; entries: { note: string }[] }
    expect(saved.shares).toEqual({ VTI: 2, VXUS: 5 })
    expect(saved.trades).toHaveLength(2)
    expect(saved.entries.map((e) => e.note)).toEqual(['Robinhood import', 'Robinhood import'])
    // Today now shows the real history line: 0 before Sep 30, then 2 VTI, then 2 VTI + 5 VXUS.
    fireEvent.click(screen.getByRole('link', { name: 'Today' }))
    expect(await screen.findByText('$975.00')).toBeInTheDocument() // 2 x 312.50 + 5 x 70
    expect(screen.getAllByText(/your real history/).length).toBeGreaterThan(0)
    // Up $375 since Sep 30, but $355 of that is the VXUS you bought: the market did +$20.
    expect(screen.getByText(/You added \$355\.00 · the market moved/)).toBeInTheDocument()
    expect(screen.getByText('+$20.00')).toBeInTheDocument()
  })

  it('a file that is not a report gets a plain-English error', async () => {
    start('#/invest')
    fireEvent.change(await screen.findByLabelText('Robinhood activity report file'), { target: { files: [new File(['hello'], 'x.csv')] } })
    expect(await screen.findByText(/doesn’t look like a Robinhood account activity report/)).toBeInTheDocument()
  })

  it('Today’s move: set a schedule, see the buy-day split, log it, then a countdown', async () => {
    start('#/today')
    fireEvent.change(await screen.findByLabelText('Dollars each buy day'), { target: { value: '100' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save my schedule' }))
    expect(await screen.findByText('Buy day')).toBeInTheDocument()
    // No holdings yet, so the split follows the targets: VTI 45% of $100.
    expect(screen.getByText('$45.00')).toBeInTheDocument()
    expect(screen.getByText('$2,400')).toBeInTheDocument() // a year of new money, twice a month
    fireEvent.click(screen.getByRole('button', { name: 'I bought these. Lay the stone' }))
    expect(await screen.findByText('✓ Stone laid')).toBeInTheDocument()
    expect(screen.getByText(/Next buy day:/)).toBeInTheDocument()
    const saved = JSON.parse(localStorage.getItem('keystone.phone.v1') ?? '{}') as { schedule: { amount: number; cadence: string }; entries: unknown[]; shares: Record<string, number> }
    expect(saved.schedule).toMatchObject({ amount: 100, cadence: 'semimonthly' })
    expect(saved.entries).toHaveLength(1)
    expect(saved.shares.VTI).toBeCloseTo(45 / 312.5, 5) // estimated at the last close
  })

  it('shows how far each ticker is below its 1-year high, as context', async () => {
    const days = Array.from({ length: 130 }, (_, i) => `2026-${String(4 + Math.floor(i / 28)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`)
    const vti = days.map((_, i) => (i === 10 ? 400 : 300))
    const prices = snapshot.prices
    if (!prices) throw new Error('fixture has prices')
    start('#/today', { ...snapshot, prices: { ...prices, history: { days, closes: { VTI: vti } } } })
    expect(await screen.findByText('25% below 1-yr high')).toBeInTheDocument()
  })

  it('wall page works and offers backup', async () => {
    start('#/wall')
    expect(await screen.findByText(/Your wall is empty/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Amount you invested in dollars'), { target: { value: '250' } })
    fireEvent.click(screen.getByRole('button', { name: 'Lay a stone' }))
    expect(await screen.findByText(/This month's stone is laid/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save a backup' })).toBeInTheDocument()
  })
})

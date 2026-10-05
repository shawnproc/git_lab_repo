import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
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
  // The prices' day has closed, and the next market day is far off, so the data counts as fresh.
  sessions: [{ day: '2026-10-02', close: '2026-10-02T20:00:00+00:00' }, { day: '2099-01-02', close: '2099-01-02T21:00:00+00:00' }],
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
    // Nothing personal was ever sent anywhere: the only requests were the public data files.
    expect(fetchSpy.mock.calls.every((c) => /\/(snapshot|status)\.json$/.test(String((c as unknown[])[0])))).toBe(true)
    expect(fetchSpy.mock.calls.every((c) => (c as unknown[]).length < 2 || !('body' in ((c as unknown[])[1] as object)))).toBe(true)
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

  it('stale prices: a clear warning, and no buy amounts', async () => {
    localStorage.setItem('keystone.phone.v1', JSON.stringify({ version: 1, holdings: {}, shares: {}, schedule: { cadence: 'semimonthly', amount: 100, anchor: '2026-10-01' }, values_as_of: null, entries: [] }))
    // Prices from Sep 28; two market days have closed since.
    const prices = snapshot.prices
    if (!prices) throw new Error('fixture has prices')
    const old = Object.fromEntries(Object.entries(prices.quotes).map(([k, q]) => [k, { ...q, day: '2026-09-28' }]))
    start('#/today', { ...snapshot, prices: { ...prices, quotes: old }, sessions: [
      { day: '2026-09-28', close: '2026-09-28T20:00:00+00:00' },
      { day: '2026-09-29', close: '2026-09-29T20:00:00+00:00' },
      { day: '2026-09-30', close: '2026-09-30T20:00:00+00:00' },
      { day: '2099-01-02', close: '2099-01-02T21:00:00+00:00' },
    ] })
    expect(await screen.findByText('These aren’t today’s prices.')).toBeInTheDocument()
    expect(screen.getByText(/market days old/)).toBeInTheDocument()
    expect(screen.getByText(/amounts for each holding are hidden/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /I bought these/ })).not.toBeInTheDocument()
    expect(screen.queryByText('$45.00')).not.toBeInTheDocument()
    expect(screen.getByTestId('prices-as-of')).toHaveTextContent('Prices as of the close on Sep 28, 2026')
  })

  it('a failed update check is shown and blocks amounts, even with recent dates', async () => {
    localStorage.setItem('keystone.phone.v1', JSON.stringify({ version: 1, holdings: {}, shares: {}, schedule: { cadence: 'semimonthly', amount: 100, anchor: '2026-10-01' }, values_as_of: null, entries: [] }))
    const status = { schema: 1, ok: false, checked_at: '2026-10-05T23:00:00Z', published_generated_at: snapshot.generated_at, kept_previous: true, errors: ['VTI: price is missing or zero'] }
    window.location.hash = '#/today'
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(new Response(JSON.stringify(url.endsWith('status.json') ? status : snapshot), { status: 200 }))))
    render(<PhoneApp />)
    expect(await screen.findByText(/failed its safety checks \(VTI: price is missing or zero\)/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /I bought these/ })).not.toBeInTheDocument()
  })

  it('price-flagged companies get no buy-day money, and the market mood never changes amounts', async () => {
    localStorage.setItem('keystone.phone.v1', JSON.stringify({ version: 1, holdings: {}, shares: {}, schedule: { cadence: 'semimonthly', amount: 100, anchor: '2026-10-01' }, values_as_of: null, entries: [] }))
    const flagged = { ...snapshot, plan: { ...snapshot.plan, targets: snapshot.plan.targets.map((t) => t.symbol === 'MSFT'
      ? { ...t, weight: 1, trend: 'steady' as const, status: 'ok' as const, valuation: { pe: 60, median_pe: 30, years_used: [2021, 2022, 2023, 2024, 2025], eps_year: 2025, flagged: true, detail: 'It costs about $60 per $1 of yearly profit, well above its usual $30.' } }
      : t) } }
    for (const mood of ['green', 'red'] as const) {
      const { unmount } = (() => {
        start('#/today', { ...flagged, mood: { ...flagged.mood, result: { ...flagged.mood.result, mood } } })
        return { unmount: () => { cleanup() } }
      })()
      expect(await screen.findByText('Buy day')).toBeInTheDocument()
      const slip = screen.getByText('Buy day').parentElement as HTMLElement
      expect(within(slip).queryByText('MSFT')).not.toBeInTheDocument()
      expect(within(slip).getByText(/Skipped for now .*MSFT/)).toBeInTheDocument()
      // Same split whatever the mood: VTI 45/60 and VXUS 15/60 of $100.
      expect(within(slip).getByText('$75.00')).toBeInTheDocument()
      expect(within(slip).getByText('$25.00')).toBeInTheDocument()
      unmount()
    }
  })

  it('Plan: switching to 80/20 moves money to the funds', async () => {
    start('#/plan')
    fireEvent.click(await screen.findByRole('radio', { name: '80/20' }))
    const saved = JSON.parse(localStorage.getItem('keystone.phone.v1') ?? '{}') as { core_pct: number }
    expect(saved.core_pct).toBe(80)
    expect(screen.getByText(/80% index funds · 20% companies/)).toBeInTheDocument()
  })

  it('locked backup: restoring asks for the passphrase and an explicit replace', async () => {
    const { encryptBackup } = await import('../phone/backup')
    const { empty } = await import('../phone/store')
    const file = await encryptBackup({ ...empty(), shares: { VTI: 3 } }, 'correct horse battery', new Date(), 100_000)
    localStorage.setItem('keystone.phone.v1', JSON.stringify({ version: 1, holdings: {}, shares: { VXUS: 1 }, values_as_of: null, entries: [] }))
    start('#/wall')
    fireEvent.change(await screen.findByLabelText('Backup file to restore'), { target: { files: [new File([file], 'b.json')] } })
    fireEvent.change(await screen.findByLabelText('Passphrase to open the backup'), { target: { value: 'wrong passphrase!' } })
    fireEvent.click(screen.getByRole('button', { name: 'Open backup' }))
    expect(await screen.findByText(/Wrong passphrase/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Passphrase to open the backup'), { target: { value: 'correct horse battery' } })
    fireEvent.click(screen.getByRole('button', { name: 'Open backup' }))
    expect(await screen.findByText(/Restoring replaces everything on this phone/)).toBeInTheDocument()
    // Nothing changed yet: the phone still has its own data until you confirm.
    expect((JSON.parse(localStorage.getItem('keystone.phone.v1') ?? '{}') as { shares: Record<string, number> }).shares).toEqual({ VXUS: 1 })
    fireEvent.click(screen.getByRole('button', { name: 'Replace everything on this phone' }))
    expect(await screen.findByText('✓ Backup restored.')).toBeInTheDocument()
    expect((JSON.parse(localStorage.getItem('keystone.phone.v1') ?? '{}') as { shares: Record<string, number> }).shares).toEqual({ VTI: 3 })
  })

  it('Top 3: ranks qualifying companies and explains each', async () => {
    const prices = snapshot.prices
    if (!prices) throw new Error('fixture has prices')
    const snap = { ...snapshot,
      prices: { ...prices, quotes: { ...prices.quotes, MSFT: { close: 400, prev_close: 398, change_pct: 0.5, day: '2026-10-02', dividend_yield_pct: 0.8 } } },
      plan: { ...snapshot.plan, targets: snapshot.plan.targets.map((t) => t.symbol === 'MSFT' ? { ...t, weight: 1.2, trend: 'improving' as const, status: 'ok' as const, affinity_reason: 'Its business got stronger since last quarter.' } : t) } }
    start('#/today', snap)
    expect(await screen.findByText('3 to put new money in')).toBeInTheDocument()
    const card = screen.getByText('3 to put new money in').parentElement as HTMLElement
    expect(within(card).getByText('Getting stronger')).toBeInTheDocument()
    expect(within(card).getByText('Pays 0.8% a year in dividends')).toBeInTheDocument()
    expect(within(card).getByText('Its business got stronger since last quarter.')).toBeInTheDocument()
    expect(within(card).getByText(/Only 1 qualify right now/)).toBeInTheDocument()
  })

  it('Sleeve vs VTI: same dollars, same days, real closes', async () => {
    const prices = snapshot.prices
    if (!prices) throw new Error('fixture has prices')
    const snap = { ...snapshot, prices: { ...prices, history: { days: ['2026-09-30', '2026-10-01', '2026-10-02'], closes: { VTI: [300, 300, 330], MSFT: [100, 100, 150] } } } }
    localStorage.setItem('keystone.phone.v1', JSON.stringify({ version: 1, holdings: {}, shares: { MSFT: 2 }, values_as_of: null, entries: [],
      trades: [{ day: '2026-09-30', symbol: 'MSFT', qty: 2, source: 'robinhood' }] }))
    start('#/today', snap)
    const card = (await screen.findByText('Your picks vs. just VTI')).parentElement as HTMLElement
    expect(within(card).getByText('$300.00')).toBeInTheDocument() // 2 MSFT x $150
    expect(within(card).getByText('$220.00')).toBeInTheDocument() // $200 into VTI at $300, now $330
    expect(within(card).getByText(/Your picks are ahead by \$80\.00/)).toBeInTheDocument()
  })

  it('wall page works and offers backup', async () => {
    start('#/wall')
    expect(await screen.findByText(/Your wall is empty/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Amount you invested in dollars'), { target: { value: '250' } })
    fireEvent.click(screen.getByRole('button', { name: 'Lay a stone' }))
    expect(await screen.findByText(/This month's stone is laid/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save locked backup' })).toBeInTheDocument()
  })
})

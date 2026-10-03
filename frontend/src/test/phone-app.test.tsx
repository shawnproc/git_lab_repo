import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PhoneApp, { type Snapshot } from '../phone/PhoneApp'
import { learn, plan } from './fixtures'

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
    fireEvent.change(await screen.findByLabelText('VTI value in dollars'), { target: { value: '$1,000' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save values' }))
    expect(screen.getByText('✓ Saved on this phone')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Split it' }))
    expect(screen.getAllByText(/^Buy/).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: /I invested \$500.00\. Lay the stone/ }))
    expect(await screen.findByText(/Stone laid for/)).toBeInTheDocument()
    const saved = JSON.parse(localStorage.getItem('keystone.phone.v1') ?? '{}') as { holdings: Record<string, number>; entries: unknown[] }
    expect(saved.entries).toHaveLength(1)
    // VTI was already over its target, so the money went to the underweight holdings instead.
    expect(saved.holdings.VTI).toBe(1000)
    expect(saved.holdings.VXUS).toBeGreaterThan(0)
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
    const { prices: _omit, ...old } = snapshot
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

  it('wall page works and offers backup', async () => {
    start('#/wall')
    expect(await screen.findByText(/Your wall is empty/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Amount you invested in dollars'), { target: { value: '250' } })
    fireEvent.click(screen.getByRole('button', { name: 'Lay a stone' }))
    expect(await screen.findByText(/This month's stone is laid/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save a backup' })).toBeInTheDocument()
  })
})

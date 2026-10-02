import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { parseRows } from '../pages/Money'
import { dashboard, holdings, learn, plan, routeFetch } from './fixtures'

vi.mock('lightweight-charts', () => ({
  createChart: () => ({
    addSeries: () => ({ setData: () => undefined }),
    timeScale: () => ({ fitContent: () => undefined, setVisibleLogicalRange: () => undefined }),
    subscribeCrosshairMove: () => undefined,
    unsubscribeCrosshairMove: () => undefined,
    remove: () => undefined,
  }),
  createSeriesMarkers: () => undefined,
  LineSeries: {},
  CrosshairMode: { Normal: 0 },
}))

const authed = { setup_required: false, authenticated: true, username: 'shawn', csrf_token: 'tok' }

function start(hash: string, extra: Record<string, unknown> = {}, calls: { url: string; init?: RequestInit }[] = []) {
  window.location.hash = hash
  vi.stubGlobal(
    'fetch',
    vi.fn(
      routeFetch(
        {
          'GET /api/auth/status': authed,
          'GET /api/dashboard': dashboard,
          'GET /api/plan': plan,
          'GET /api/holdings': holdings,
          'GET /api/learn': learn,
          ...extra,
        },
        calls,
      ),
    ),
  )
  render(<App />)
}

afterEach(() => {
  vi.unstubAllGlobals()
  window.location.hash = ''
})

describe('Home', () => {
  it('shows the mood in plain words with an explainer, and portfolio numbers', async () => {
    start('#/home')
    expect(await screen.findByText('Green')).toBeInTheDocument()
    expect(screen.getByText(/Calm and rising/)).toBeInTheDocument()
    expect(screen.getAllByText(/What does this mean\?/).length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText(/nicknamed the “fear gauge”/)).toBeInTheDocument()
    expect(screen.getByText('$3,000.00')).toBeInTheDocument()
    expect(screen.getByText('+$500.00')).toBeInTheDocument()
    expect(screen.queryByText(/old or missing/)).not.toBeInTheDocument()
  })

  it('warns loudly when data is stale', async () => {
    start('#/home', {
      'GET /api/dashboard': {
        ...dashboard,
        index_freshness: { ...dashboard.index_freshness, stale: true, reason: 'latest data is 2026-09-30, 2 session(s) behind' },
      },
    })
    expect(await screen.findByText(/Some numbers are old or missing/)).toBeInTheDocument()
    expect(screen.getByText(/2 session\(s\) behind/)).toBeInTheDocument()
  })

  it('has navigation to every page', async () => {
    start('#/home')
    const nav = await screen.findByRole('navigation', { name: 'Main' })
    for (const label of ['Home', 'My Plan', 'My Money', 'Charts', 'Learn']) {
      expect(within(nav).getByText(label)).toBeInTheDocument()
    }
  })
})

describe('My Plan', () => {
  it('shows targets with plain labels, dollar amounts and why', async () => {
    start('#/plan')
    expect(await screen.findByText(/Safe foundation \(core\): 60%/)).toBeInTheDocument()
    expect(screen.getByText(/Hand-picked companies: 40%/)).toBeInTheDocument()
    expect(screen.getByText('$4,500.00')).toBeInTheDocument()
    expect(screen.getByText('Sales grew about 14% a year.')).toBeInTheDocument()
    expect(screen.getByText(/pretend/)).toBeInTheDocument()
  })

  it('expands a company to show its five questions', async () => {
    start('#/plan')
    const row = await screen.findByRole('button', { name: /NKE/ })
    expect(screen.queryByText(/Sales grew 1.0% a year/)).not.toBeInTheDocument()
    fireEvent.click(row)
    const item = row.closest('li')
    if (!item) throw new Error('row not in a list item')
    expect(within(item).getByText('Are sales growing?')).toBeInTheDocument()
    expect(within(item).getByText(/Sales grew 1.0% a year/)).toBeInTheDocument()
  })
})

describe('My Money', () => {
  it('validates rows in plain English', () => {
    const r = parseRows([
      { id: 1, symbol: 'v t i', shares: '1', avg_cost: '1' },
      { id: 2, symbol: 'VXUS', shares: '0', avg_cost: '-1' },
      { id: 3, symbol: '', shares: '', avg_cost: '' },
      { id: 4, symbol: 'aapl', shares: '1,000', avg_cost: '$1,234.50' },
    ])
    expect(r.problems[0]).toMatch(/doesn’t look like a ticker symbol/)
    expect(r.problems).toContain('Line 2: number of shares must be more than 0.')
    expect(r.holdings).toContainEqual({ symbol: 'AAPL', shares: 1000, avg_cost: 1234.5 })
  })

  it('saves holdings with the CSRF token and shows drift', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    start('#/money', { 'PUT /api/holdings': holdings }, calls)
    expect(await screen.findByText(/2 item\(s\) have drifted/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText('✓ Saved')
    const put = calls.find((c) => c.init?.method === 'PUT')
    expect((put?.init?.headers as Record<string, string>)['x-csrf-token']).toBe('tok')
    expect(JSON.parse(put?.init?.body as string)).toEqual({ holdings: [{ symbol: 'VTI', shares: 10, avg_cost: 250 }] })
  })

  it('splits a monthly contribution into plain instructions', async () => {
    start('#/money', {
      'POST /api/contribution': {
        amount: 500,
        allocations: [{ symbol: 'VXUS', amount: 500, shares: 7.5, price: 66.67 }],
        leftover: 0,
        note: '',
      },
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Show me how to split it' }))
    expect(await screen.findByText(/Here’s what to buy/)).toBeInTheDocument()
    expect(screen.getByText(/≈ 7.5 shares at about \$66.67 each/)).toBeInTheDocument()
  })
})

describe('Charts', () => {
  it('lists marked moments with explanations', async () => {
    start('#/charts', {
      'GET /api/chart/VTI': {
        symbol: 'VTI',
        freshness: dashboard.index_freshness,
        points: [{ day: '2026-10-02', open: 1, high: 1, low: 1, close: 1, sma50: 1, sma200: 1 }],
        events: [{ day: '2026-09-01', kind: 'death_cross', price: 290, label: 'Death cross', explanation: 'Information, not an alarm.' }],
      },
    })
    expect(await screen.findByText('Moments on this chart (1)')).toBeInTheDocument()
    expect(screen.getByText('Information, not an alarm.')).toBeInTheDocument()
    expect(screen.getByText(/How do I read this chart/)).toBeInTheDocument()
  })
})

describe('Learn', () => {
  it('searches the glossary and explains pending links', async () => {
    start('#/learn')
    expect(await screen.findByText('VIX (the “fear gauge”)')).toBeInTheDocument()
    expect(screen.getByText(/3 link\(s\) are waiting to be checked/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Search the word list'), { target: { value: 'basket' } })
    await waitFor(() => { expect(screen.queryByText('VIX (the “fear gauge”)')).not.toBeInTheDocument() })
    expect(screen.getByText('ETF (exchange-traded fund)')).toBeInTheDocument()
  })
})

import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import type { Freshness, MarketStatus } from '../api'

function routeFetch(routes: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      const body = routes[url]
      if (body === undefined) return Promise.resolve(new Response(null, { status: 404 }))
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))
    }),
  )
}

const fresh: Freshness = {
  source: 'yfinance',
  fetched_at: '2026-10-02T21:00:00Z',
  last_day: '2026-10-02',
  expected_day: '2026-10-02',
  stale: false,
  reason: '',
  last_error: '',
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('App', () => {
  it('shows first-run setup when no account exists', async () => {
    routeFetch({
      '/api/auth/status': { setup_required: true, authenticated: false, username: null, csrf_token: null },
    })
    render(<App />)
    expect(await screen.findByText('First-run setup')).toBeInTheDocument()
    expect(screen.getByText(/not financial advice/i)).toBeInTheDocument()
  })

  it('shows login when signed out', async () => {
    routeFetch({
      '/api/auth/status': { setup_required: false, authenticated: false, username: null, csrf_token: null },
    })
    render(<App />)
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument()
  })

  it('warns loudly when data is stale and shows source + timestamps', async () => {
    const status: MarketStatus = {
      benchmark: 'SPY',
      benchmark_close: 600.12,
      benchmark_day: '2026-10-01',
      benchmark_freshness: { ...fresh, last_day: '2026-10-01', stale: true, reason: 'latest data is 2026-10-01, 1 session(s) behind' },
      vix: 16.5,
      vix_day: '2026-10-01',
      vix_freshness: fresh,
      any_stale: true,
    }
    routeFetch({
      '/api/auth/status': { setup_required: false, authenticated: true, username: 'shawn', csrf_token: 't' },
      '/api/market/status': status,
    })
    render(<App />)
    expect(await screen.findByText(/Stale or missing data/)).toBeInTheDocument()
    expect(screen.getByText(/1 session\(s\) behind/)).toBeInTheDocument()
    expect(screen.getByText('600.12')).toBeInTheDocument()
    expect(screen.getAllByText('yfinance')).toHaveLength(2)
  })

  it('shows no stale banner when everything is fresh', async () => {
    routeFetch({
      '/api/auth/status': { setup_required: false, authenticated: true, username: 'shawn', csrf_token: 't' },
      '/api/market/status': {
        benchmark: 'SPY', benchmark_close: 600, benchmark_day: '2026-10-02', benchmark_freshness: fresh,
        vix: 15, vix_day: '2026-10-02', vix_freshness: fresh, any_stale: false,
      },
    })
    render(<App />)
    expect(await screen.findByText('600.00')).toBeInTheDocument()
    expect(screen.queryByText(/Stale or missing data/)).not.toBeInTheDocument()
  })
})

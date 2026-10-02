import type { Dashboard, Freshness, Holdings, Learn, Plan } from '../api'

export const fresh: Freshness = {
  source: 'yfinance',
  fetched_at: '2026-10-02T21:00:00Z',
  last_day: '2026-10-02',
  expected_day: '2026-10-02',
  stale: false,
  reason: '',
  last_error: '',
}

export const dashboard: Dashboard = {
  mood: {
    mood: 'green',
    headline: 'Calm and rising. Business as usual: keep adding money on your normal schedule.',
    reasons: ['Direction: up.', 'Nerves: calm.'],
    index_close: 6500,
    index_ma: 6000,
    vix: 15,
  },
  index_freshness: fresh,
  vix_freshness: fresh,
  portfolio: {
    positions: [{ symbol: 'VTI', shares: 10, avg_cost: 250, price: 300, value: 3000, day_change: 30, cost_basis: 2500 }],
    value: 3000,
    cost_basis: 2500,
    day_change: 30,
    day_change_pct: 1.01,
    total_change: 500,
    total_change_pct: 20,
    missing_prices: [],
  },
  holdings_freshness: { VTI: fresh },
  any_stale: false,
}

export const plan: Plan = {
  targets: [
    { symbol: 'VTI', name: 'Vanguard Morningstar Total Stock Market ETF', kind: 'core', target_pct: 45, target_value: 4500, why: 'Owns nearly every US company.' },
    { symbol: 'VXUS', name: 'Vanguard Total International Stock ETF', kind: 'core', target_pct: 15, target_value: 1500, why: 'Owns companies outside the US.' },
    { symbol: 'MSFT', name: 'Microsoft Corp', kind: 'stock', target_pct: 40, target_value: 4000, why: 'Sales grew about 14% a year.' },
  ],
  screen: [
    {
      symbol: 'MSFT', sector: 'Technology', company: 'Microsoft Corp', qualifies: true, score: 58, picked: true,
      why: 'Sales grew.', note: '',
      checks: [
        { key: 'revenue_growth', label: 'Are sales growing?', status: 'pass', detail: 'Sales grew about 14.0% a year.' },
        { key: 'debt', label: 'Is the debt manageable?', status: 'unavailable', detail: 'Not reported.' },
      ],
    },
    {
      symbol: 'NKE', sector: 'Consumer Discretionary', company: 'Nike', qualifies: false, score: 14, picked: false,
      why: '', note: '',
      checks: [{ key: 'revenue_growth', label: 'Are sales growing?', status: 'fail', detail: 'Sales grew 1.0% a year.' }],
    },
  ],
  fundamentals: { source: 'sec_edgar', fetched_at: '2026-10-01T12:00:00Z', stale: false, reason: '', last_error: '' },
  basis_value: 10000,
  basis_is_reference: true,
}

export const holdings: Holdings = {
  drift: [
    { symbol: 'VTI', kind: 'core', target_pct: 45, actual_pct: 100, diff_pp: 55, target_value: 1350, actual_value: 3000, flagged: true, reason: '55.0 percentage points above its target' },
    { symbol: 'VXUS', kind: 'core', target_pct: 15, actual_pct: 0, diff_pp: -15, target_value: 450, actual_value: 0, flagged: true, reason: '15.0 percentage points below its target' },
  ],
  portfolio: dashboard.portfolio,
  freshness: { VTI: fresh },
}

export const learn: Learn = {
  glossary: [
    { term: 'VIX (the “fear gauge”)', definition: 'Measures nerves.', why_it_matters: 'Shows fear.', example: 'Over 30 in 2020.' },
    { term: 'ETF (exchange-traded fund)', definition: 'A basket.', why_it_matters: 'Spreads money.' },
  ],
  faq: [{ q: 'Is this financial advice?', a: 'No.' }],
  links: [],
  pending_links: 3,
}

export function routeFetch(routes: Record<string, unknown>, calls: { url: string; init?: RequestInit }[] = []) {
  return (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const key = `${init?.method ?? 'GET'} ${url.split('?')[0] ?? url}`
    const body = routes[key] ?? routes[url]
    if (body === undefined) return Promise.resolve(new Response(JSON.stringify({ detail: 'not found' }), { status: 404 }))
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))
  }
}

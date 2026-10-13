import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DossierCard } from '../phone/DossierCard'
import { EVENT_WORDS, filingLink, parseDossier, resetDossierCache, sizeWord, summarize, type Trade } from '../phone/dossier'
import { parseNews, parseRatings } from '../phone/live'
import { LiveProvider } from '../phone/LiveContext'
import { insidersBuying } from '../phone/radar'
import type { Company } from '../phone/research'

const trades: Trade[] = [
  ['2026-10-09', 'Jane CEO', 'Chief Executive Officer', 'P', 1000, 150_000, 0],
  ['2026-09-20', 'Bob Director', 'Director', 'P', 200, 30_000, 0],
  ['2026-08-01', 'Sue CFO', 'Chief Financial Officer', 'S', 5000, 900_000, 1],
  ['2026-07-15', 'Al VP', 'VP', 'S', 100, 20_000, 0],
]
const raw = {
  schema: 1, generated_at: '2026-10-13T23:00:00+00:00', window_days: 90, days: ['2026-10-12', '2026-10-09'],
  companies: {
    ACME: { t: trades, e: [['2026-10-12', '2.02,5.02', 'edgar/data/123/0000000123-26-000077.txt'], ['2026-09-01', '4.02', 'edgar/data/123/0000000123-26-000070.txt']] },
    'bad<': { t: [], e: [] },
    OK: { t: [['2026-10-01', 'x', 'y', 'Z', 1, 1, 0], ['nope']], e: [['2026-10-01', '1.01', 'http://evil.example/x']] },
  },
}
const acme: Company = { s: 'ACME', n: 'Acme Corp', v: 'fit', h: '', close: 20, chg: 1, day: '2026-10-12', dy: null, rev: 900e6, g3: 30, qp: '2026Q2', qg: 12, qom: 8, qom0: 12, mcap: 1.5e9, ps: 1.7 }

describe('dossier data', () => {
  it('validates row by row, dropping damage instead of repairing it', () => {
    const d = parseDossier(raw)
    expect(Object.keys(d.companies)).toEqual(['ACME']) // the bad ticker, bad trade and non-SEC link are all gone
    expect(d.companies.ACME?.e).toHaveLength(2)
    expect(() => parseDossier({ schema: 2 })).toThrow()
  })

  it('summarizes insider buying and spots a cluster', () => {
    expect(summarize(trades)).toEqual({ buys: 2, buyers: 2, bought: 180_000, sold: 920_000, soldUnplanned: 20_000, cluster: true })
    expect(summarize(trades.slice(0, 1)).cluster).toBe(false) // one insider is not a cluster
  })

  it('explains events and links to the SEC filing', () => {
    expect(EVENT_WORDS['4.02']?.[1]).toBe('red')
    expect(filingLink('edgar/data/123/0000000123-26-000077.txt')).toBe('https://www.sec.gov/Archives/edgar/data/123/000000012326000077/0000000123-26-000077-index.htm')
    expect(sizeWord(1.5e9)).toMatch(/Small-cap/)
    expect(sizeWord(null)).toBeNull()
  })

  it('ranks insider buying on the radar: clusters first', () => {
    const d = parseDossier(raw)
    const rows = insidersBuying([acme, { ...acme, s: 'NONE' }], d)
    expect(rows.map((r) => r.c.s)).toEqual(['ACME'])
    expect(rows[0]?.why).toBe('2 different insiders bought $180,000 with their own money within a month of each other')
  })

  it('keeps only sane analyst counts and https news', () => {
    expect(parseRatings([{ period: '2026-10-01', strongBuy: 5, buy: 10, hold: 4, sell: 1, strongSell: 0 }, { period: 'x', buy: 1 }])).toHaveLength(1)
    const news = parseNews([
      { datetime: 1_760_000_000, headline: 'Acme wins contract', source: 'Wire', url: 'https://news.example/a' },
      { datetime: 1_760_000_100, headline: 'Bad link', source: 'X', url: 'javascript:alert(1)' },
      { datetime: 1_760_000_200, headline: 'Plain http', source: 'X', url: 'http://news.example/b' },
    ])
    expect(news.map((n) => n.headline)).toEqual(['Acme wins contract'])
  })
})

describe('dossier card', () => {
  beforeEach(() => { localStorage.clear(); resetDossierCache() })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('shows all five parts, in plain words', async () => {
    localStorage.setItem('keystone.live.v1', 'abcd1234efgh5678ijkl')
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.endsWith('dossier.json')) return Promise.resolve(new Response(JSON.stringify(raw), { status: 200 }))
      if (url.includes('stock/recommendation')) return Promise.resolve(new Response(JSON.stringify([{ period: '2026-10-01', strongBuy: 3, buy: 7, hold: 4, sell: 1, strongSell: 0 }]), { status: 200 }))
      if (url.includes('company-news')) return Promise.resolve(new Response(JSON.stringify([{ datetime: 1_760_000_000, headline: 'Acme wins contract', source: 'Wire', url: 'https://news.example/a' }]), { status: 200 }))
      return Promise.resolve(new Response('{}', { status: 404 }))
    }))
    render(<LiveProvider symbols={[]}><DossierCard c={acme} /></LiveProvider>)
    expect(await screen.findByText(/Cluster buying: 2 different insiders/)).toBeInTheDocument()
    expect(screen.getByText(/Still filling in: 2 filing days/)).toBeInTheDocument()
    expect(screen.getByText('+12.0%')).toBeInTheDocument() // the quarter vs a year earlier
    expect(screen.getByText(/Growth this quarter is well below its usual pace/)).toBeInTheDocument() // 12% vs 30%
    expect(screen.getByText(/Said past financial statements can’t be relied on/)).toBeInTheDocument()
    expect(screen.getByText(/Small-cap/)).toBeInTheDocument()
    expect(await screen.findByText(/15 analysts/)).toBeInTheDocument()
    expect(await screen.findByRole('link', { name: 'Acme wins contract' })).toHaveAttribute('rel', 'noreferrer noopener')
  })

  it('says what is missing without a key or data', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('', { status: 404 }))))
    render(<LiveProvider symbols={[]}><DossierCard c={acme} /></LiveProvider>)
    expect((await screen.findAllByText(/isn’t published yet/)).length).toBeGreaterThan(0)
    expect(screen.getByText(/Add your free Finnhub key/)).toBeInTheDocument()
  })
})

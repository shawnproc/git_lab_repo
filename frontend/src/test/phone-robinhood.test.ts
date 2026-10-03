import { describe, expect, it } from 'vitest'
import { accountSeries, flowsBetween, type History, sharesByDay } from '../phone/portfolio'
import { parseCsv, parseMoney, parseRobinhood, type Trade } from '../phone/robinhood'
import { parseData } from '../phone/store'

const HEAD = '"Activity Date","Process Date","Settle Date","Instrument","Description","Trans Code","Quantity","Price","Amount"'
const row = (day: string, sym: string, desc: string, code: string, qty: string, price: string, amt: string) =>
  `"${day}","${day}","${day}","${sym}","${desc}","${code}","${qty}","${price}","${amt}"`

// Newest first, like Robinhood. Includes a multi-line description, a dividend and its
// reinvestment, a deposit, a split, an options trade and the closing disclaimer.
const REPORT = [
  HEAD,
  row('9/18/2026', 'VTI', 'Vanguard Total Stock Market ETF\nCUSIP: 922908769\nDividend Reinvestment', 'Buy', '0.05', '$310.00', '($15.50)'),
  row('9/15/2026', 'VTI', 'Cash Div: R/D 2026-09-01 P/D 2026-09-15 - 10.5 shares at 1.476', 'CDIV', '', '', '$15.50'),
  row('9/2/2026', 'VTI', 'Vanguard Total Stock Market ETF\nCUSIP: 922908769', 'Buy', '0.5', '$300.00', '($150.00)'),
  row('8/20/2026', 'NVDA', 'NVIDIA', 'Sell', '1', '$120.00', '$120.00'),
  row('6/10/2026', 'NVDA', 'Forward Split', 'SPL', '9', '', ''),
  row('5/3/2026', 'NVDA', 'NVIDIA', 'Buy', '1', '$1,000.00', '($1,000.00)'),
  row('5/1/2026', '', 'ACH Deposit', 'ACH', '', '', '$1,500.00'),
  row('4/4/2026', 'AAPL 5/16/2026 Call $200.00', 'AAPL Call', 'BTO', '1', '$2.00', '($200.00)'),
  row('3/2/2026', 'VTI', 'Vanguard Total Stock Market ETF', 'Buy', '10', '$280.00', '($2,800.00)'),
  '',
  '"","","","","The data provided is for informational purposes only. Please consult a professional tax service.","","","",""',
].join('\r\n')

describe('Robinhood activity report', () => {
  it('rebuilds shares, splits and monthly new money', () => {
    const r = parseRobinhood(REPORT)
    expect(r.shares).toEqual({ VTI: 10.55, NVDA: 9 }) // 1 + 9 split - 1 sold
    expect(r.counts).toEqual({ rows: 9, buys: 4, sells: 1, ignored: 3 })
    // New money only: the dividend reinvestment isn't money you added.
    expect(r.months).toEqual([
      { month: '2026-03', amount: 2800 },
      { month: '2026-05', amount: 1000 },
      { month: '2026-09', amount: 150 },
    ])
    expect(r.first_day).toBe('2026-03-02')
    expect(r.trades.find((t) => t.symbol === 'NVDA' && t.split)?.qty).toBe(9)
    expect(r.warnings).toEqual(['1 options row skipped: this app tracks shares only.'])
  })

  it('warns when the report starts after your first buy', () => {
    const r = parseRobinhood([HEAD, row('8/20/2026', 'KO', 'Coca-Cola', 'Sell', '5', '$60.00', '$300.00')].join('\n'))
    expect(r.warnings[0]).toMatch(/sells more KO than it buys/)
    expect(r.shares).toEqual({})
  })

  it('reports codes it does not understand instead of guessing', () => {
    const r = parseRobinhood([HEAD, row('8/20/2026', 'XYZ', 'Merger', 'MRGS', '5', '', '')].join('\n'))
    expect(r.warnings[0]).toMatch(/“MRGS” row changed shares/)
    expect(r.shares).toEqual({})
  })

  it('rejects files that are not activity reports', () => {
    expect(() => parseRobinhood('Date,Amount\n1/1/2026,5')).toThrow(/doesn’t look like a Robinhood/)
  })

  it('parses CSV quoting and money formats', () => {
    expect(parseCsv('a,"b ""q""","c\nd"\r\n1,2,3')).toEqual([['a', 'b "q"', 'c\nd'], ['1', '2', '3']])
    expect(parseMoney('($1,234.50)')).toBe(-1234.5)
    expect(parseMoney('$43.64')).toBe(43.64)
    expect(parseMoney('abc')).toBeNull()
  })

  it('imported trades survive a backup round trip, and bad ones are rejected', () => {
    const trades: Trade[] = parseRobinhood(REPORT).trades
    const d = parseData({ version: 1, holdings: {}, shares: {}, trades, values_as_of: null, entries: [] })
    expect(d.trades).toEqual(trades)
    expect(() => parseData({ version: 1, holdings: {}, trades: [{ day: '2026-13-01', symbol: 'VTI', qty: 1, source: 'robinhood' }], values_as_of: null, entries: [] })).toThrow()
    expect(() => parseData({ version: 1, holdings: {}, trades: [{ day: '2026-01-01', symbol: 'VTI', qty: 1, source: 'hacker' }], values_as_of: null, entries: [] })).toThrow()
  })
})

describe('account history', () => {
  // Split-adjusted closes, as Yahoo reports them: NVDA did 10-for-1 on Jun 10.
  const history: History = {
    days: ['2026-06-08', '2026-06-09', '2026-06-10', '2026-06-11'],
    closes: { NVDA: [100, 101, 102, 103], VTI: [300, 300, 300, 300] },
    splits: { NVDA: [['2026-06-10', 10]] },
  }
  const trades = [
    { day: '2026-06-01', symbol: 'NVDA', qty: 1 }, // 1 pre-split share = 10 of today's
    { day: '2026-06-11', symbol: 'NVDA', qty: 2 }, // bought after the split: already today's terms
    { day: '2026-06-11', symbol: 'NVDA', qty: 9, split: true }, // Robinhood's split row, a day late
  ]

  it('scales trades before a split and ignores Robinhood’s split row inside the window', () => {
    expect(sharesByDay('NVDA', trades, history)).toEqual([10, 10, 10, 12])
  })

  it('values the account day by day with real share counts, no jump at the split', () => {
    const { points } = accountSeries({}, trades, history)
    expect(points.map((p) => p.value)).toEqual([1000, 1010, 1020, 1236])
  })

  it('keeps an older split row as a real share count', () => {
    const old = [{ day: '2025-01-02', symbol: 'VTI', qty: 2 }, { day: '2025-02-02', symbol: 'VTI', qty: 2, split: true }]
    expect(sharesByDay('VTI', old, history)).toEqual([4, 4, 4, 4])
  })

  it('starts the line at your first day with money in', () => {
    const { points } = accountSeries({}, [{ day: '2026-06-10', symbol: 'VTI', qty: 1 }], history)
    expect(points.map((p) => p.day)).toEqual(['2026-06-10', '2026-06-11'])
  })
})

describe('money added vs market', () => {
  it('counts buys at that day’s close as money added, so the rest is the market', () => {
    const history: History = { days: ['2026-06-08', '2026-06-09', '2026-06-10'], closes: { VTI: [100, 110, 120] } }
    const { points } = accountSeries({}, [{ day: '2026-06-08', symbol: 'VTI', qty: 1 }, { day: '2026-06-10', symbol: 'VTI', qty: 1 }], history)
    expect(points.map((p) => p.value)).toEqual([100, 110, 240])
    const [first, , last] = points
    if (!first || !last) throw new Error('missing points')
    expect(flowsBetween(points, first, last)).toBe(120) // the second share, bought at 120
    // 240 - 100 = +140 change; 120 added; the market did +20.
  })
  it('is null without a trade history', () => {
    expect(flowsBetween([{ day: '2026-01-01', value: 5 }], null, { day: '2026-01-01', value: 5 })).toBeNull()
  })
})

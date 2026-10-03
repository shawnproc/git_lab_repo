import { describe, expect, it } from 'vitest'
import { change, chartable, holdingValues, inRange, rangeStart, tickerSeries, valueSeries, type History } from '../phone/portfolio'

const history: History = {
  days: ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02'],
  closes: {
    VTI: [300, 302, 301, 305, 310],
    VXUS: [70, null, 71, 72, 70], // a missing day
  },
}
const quotes = {
  VTI: { close: 310, prev_close: 305, change_pct: 1.64, day: '2026-10-02' },
  VXUS: { close: 70, prev_close: 72, change_pct: -2.78, day: '2026-10-02' },
}

describe('holding values', () => {
  it('uses shares x last close, else the dollars you typed', () => {
    expect(holdingValues({ VTI: 2.5 }, { VXUS: 100, XYZ: 40 }, quotes)).toEqual({ VTI: 775, VXUS: 100, XYZ: 40 })
  })

  it('shares win over typed dollars when a price exists', () => {
    expect(holdingValues({ VTI: 1 }, { VTI: 999 }, quotes)).toEqual({ VTI: 310 })
  })

  it('keeps typed dollars when there is no price for that ticker', () => {
    expect(holdingValues({ ZZZ: 3 }, { ZZZ: 50 }, quotes)).toEqual({ ZZZ: 50 })
  })
})

describe('value line', () => {
  it('sums shares x close and skips a day any ticker is missing (no filling in)', () => {
    const pts = valueSeries({ VTI: 2, VXUS: 10 }, history)
    expect(pts.map((p) => p.day)).toEqual(['2026-09-28', '2026-09-30', '2026-10-01', '2026-10-02'])
    expect(pts.at(-1)?.value).toBe(2 * 310 + 10 * 70)
  })

  it('only charts tickers with shares and a history', () => {
    expect(chartable({ VTI: 2, XYZ: 5, VXUS: 0 }, history)).toEqual(['VTI'])
    expect(valueSeries({}, history)).toEqual([])
  })

  it('ticker line skips gaps', () => {
    expect(tickerSeries('VXUS', history).map((p) => p.value)).toEqual([70, 71, 72, 70])
  })
})

describe('ranges', () => {
  it('computes the first day of each range', () => {
    expect(rangeStart('1W', '2026-10-02')).toBe('2026-09-25')
    expect(rangeStart('1M', '2026-10-02')).toBe('2026-09-02')
    expect(rangeStart('3M', '2026-10-02')).toBe('2026-07-02')
    expect(rangeStart('YTD', '2026-10-02')).toBe('2026-01-01')
    expect(rangeStart('1Y', '2026-10-02')).toBe('2025-10-02')
    expect(rangeStart('1M', '2026-03-31')).toBe('2026-02-28') // not March 3
  })

  it('measures change from the close before the range starts', () => {
    const pts = valueSeries({ VTI: 1 }, history)
    const r = inRange(pts, '1W')
    expect(r.points[0]?.day).toBe('2026-09-28')
    expect(r.base?.value).toBe(300) // nothing earlier, so the first day
    const c = change(310, 300)
    expect(c.amount).toBe(10)
    expect(c.pct).toBeCloseTo(3.3333)
  })
})

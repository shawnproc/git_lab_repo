import { describe, expect, it } from 'vitest'
import { belowHigh, type History } from '../phone/portfolio'
import { buyStatus, nextStart, periodStart, type Schedule } from '../phone/schedule'

const S = (cadence: Schedule['cadence'], anchor = '2026-10-02'): Schedule => ({ cadence, amount: 75, anchor })

describe('buy schedule', () => {
  it('twice a month: the 1st and the 15th', () => {
    expect(periodStart('2026-10-04', S('semimonthly'))).toBe('2026-10-01')
    expect(nextStart('2026-10-04', S('semimonthly'))).toBe('2026-10-15')
    expect(periodStart('2026-10-20', S('semimonthly'))).toBe('2026-10-15')
    expect(nextStart('2026-12-20', S('semimonthly'))).toBe('2027-01-01')
  })

  it('weekly and every 2 weeks follow the first buy day', () => {
    expect(periodStart('2026-10-08', S('weekly'))).toBe('2026-10-02') // a Friday
    expect(nextStart('2026-10-08', S('weekly'))).toBe('2026-10-09')
    expect(periodStart('2026-10-20', S('biweekly'))).toBe('2026-10-16')
    expect(nextStart('2026-10-20', S('biweekly'))).toBe('2026-10-30')
  })

  it('monthly', () => {
    expect(periodStart('2026-10-31', S('monthly'))).toBe('2026-10-01')
    expect(nextStart('2026-10-31', S('monthly'))).toBe('2026-11-01')
  })

  it('is due until you log a buy in this period, then counts down', () => {
    expect(buyStatus('2026-10-04', S('semimonthly'), [])).toEqual({ due: true, since: '2026-10-01', next: '2026-10-15', days_to_next: 11 })
    expect(buyStatus('2026-10-04', S('semimonthly'), ['2026-09-20']).due).toBe(true) // last period's buy
    expect(buyStatus('2026-10-04', S('semimonthly'), ['2026-10-02']).due).toBe(false)
  })
})

describe('below its 1-year high', () => {
  const days = Array.from({ length: 252 }, (_, i) => `d${String(i)}`)
  it('measures the last close against the highest close', () => {
    const closes = days.map((_, i) => (i === 100 ? 200 : 150))
    const h: History = { days, closes: { X: closes } }
    expect(belowHigh('X', h)).toEqual({ pct: 25, high: 200, months: 12 })
  })
  it('needs enough history', () => {
    expect(belowHigh('X', { days: days.slice(0, 50), closes: { X: days.slice(0, 50).map(() => 10) } })).toBeNull()
  })
})

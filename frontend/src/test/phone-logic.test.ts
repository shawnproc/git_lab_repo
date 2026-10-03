// Same scenarios and numbers as backend/tests/test_plan.py and test_wall.py, so the phone and the
// Python engine provably agree.
import { describe, expect, it } from 'vitest'
import { buildWall, drift, type Entry, type PlanTarget, splitContribution } from '../phone/logic'
import { parseData } from '../phone/store'

const T = (symbol: string, kind: 'core' | 'stock', target_pct: number): PlanTarget => ({ symbol, name: symbol, kind, target_pct, why: '' })
const RULES = { max_abs_pp: 5, max_relative_pct: 25 }

describe('drift (matches Python)', () => {
  it('flags absolute, relative and off-plan', () => {
    const rows = Object.fromEntries(
      drift([T('VTI', 'core', 60), T('AAPL', 'stock', 6), T('MSFT', 'stock', 34)], { VTI: 540, AAPL: 76, MSFT: 340, GME: 44 }, RULES)
        .map((r) => [r.symbol, r]),
    )
    expect(rows.VTI?.reason).toContain('6.0 percentage points below its target')
    expect(rows.AAPL?.flagged).toBe(true)
    expect(rows.AAPL?.reason).toBe('1.6 percentage points above its target (about 27% more than planned)')
    expect(rows.MSFT?.flagged).toBe(false)
    expect(rows.GME?.kind).toBe('off_plan')
    expect(rows.VTI?.target_value).toBeCloseTo(600)
  })

  it('says “you don’t own any yet”', () => {
    const rows = drift([T('VTI', 'core', 60), T('VXUS', 'core', 40)], { VTI: 10 }, RULES)
    expect(rows[1]?.reason).toBe("you don't own any yet")
    expect(rows[1]?.flagged).toBe(true)
  })
})

describe('splitContribution (matches Python)', () => {
  const targets = [T('VTI', 'core', 60), T('VXUS', 'core', 20), T('AAPL', 'stock', 20)]
  it('fills underweights first, never sells', () => {
    const { allocations, leftover } = splitContribution(500, targets, { VTI: 700, VXUS: 100, AAPL: 200 })
    expect(Object.fromEntries(allocations.map((a) => [a.symbol, a.amount]))).toEqual({ VTI: 200, VXUS: 200, AAPL: 100 })
    expect(leftover).toBe(0)
  })
  it('is proportional when money is short', () => {
    const { allocations } = splitContribution(100, targets, { VTI: 2000 })
    expect(Object.fromEntries(allocations.map((a) => [a.symbol, a.amount]))).toEqual({ VXUS: 50, AAPL: 50 })
  })
  it('follows weights when on target', () => {
    const { allocations } = splitContribution(1000, targets, { VTI: 600, VXUS: 200, AAPL: 200 })
    expect(Object.fromEntries(allocations.map((a) => [a.symbol, a.amount]))).toEqual({ VTI: 600, VXUS: 200, AAPL: 200 })
  })
  it('always adds up to exactly the amount typed (no $500.01)', () => {
    const three = [T('A', 'core', 100 / 3), T('B', 'core', 100 / 3), T('C', 'stock', 100 / 3)]
    const { allocations, leftover } = splitContribution(500, three, {})
    expect(Math.round(allocations.reduce((a, x) => a + x.amount, 0) * 100)).toBe(50000)
    expect(leftover).toBe(0)
  })
  it('with no holdings yet, follows the targets exactly', () => {
    const { allocations } = splitContribution(500, targets, {})
    expect(Object.fromEntries(allocations.map((a) => [a.symbol, a.amount]))).toEqual({ VTI: 300, VXUS: 100, AAPL: 100 })
  })
})

const e = (month: string, amount = 100): Entry => ({ id: month + String(amount), month, amount, note: '', created_at: '2026-01-01T00:00:00Z' })

describe('buildWall (matches Python)', () => {
  it('streak grace for the open month, and the message', () => {
    const w = buildWall([e('2026-07'), e('2026-08'), e('2026-09')], '2026-10')
    expect(w.current_streak).toBe(3)
    expect(w.message).toContain('3 months in a row')
    expect(w.courses[0]?.stones[9]?.state).toBe('open')
  })
  it('missed month breaks current but not longest', () => {
    const w = buildWall(['2026-01', '2026-02', '2026-03', '2026-04', '2026-09'].map((m) => e(m)), '2026-10')
    expect(w.current_streak).toBe(1)
    expect(w.longest_streak).toBe(4)
    expect(w.courses[0]?.stones[4]?.state).toBe('missed')
  })
  it('a full year earns a keystone; newest year on top', () => {
    const w = buildWall(Array.from({ length: 12 }, (_, i) => e(`2025-${String(i + 1).padStart(2, '0')}`, 50)), '2026-10')
    expect(w.courses.map((c) => c.year)).toEqual([2026, 2025])
    expect(w.courses[1]?.keystone).toBe(true)
    expect(w.courses[1]?.total).toBe(600)
  })
  it('sums a month, ignores the future, marks before-start', () => {
    const w = buildWall([e('2026-06', 200), e('2026-06', 300.5), e('2027-01')], '2026-10')
    expect(w.courses[0]?.stones[5]).toMatchObject({ state: 'laid', amount: 500.5, entries: 2 })
    expect(w.courses[0]?.stones[0]?.state).toBe('before_start')
    expect(w.total).toBe(500.5)
    expect(w.message).toBe('No stone yet this month. Every month you invest adds one.')
  })
})

describe('backup validation', () => {
  const good = { version: 1, holdings: { VTI: 1000 }, values_as_of: null, entries: [e('2026-09')] }
  it('accepts a good backup', () => {
    expect(parseData(good).holdings.VTI).toBe(1000)
  })
  it.each([
    [{ ...good, version: 2 }],
    [{ ...good, holdings: { 'VT I': 1 } }],
    [{ ...good, holdings: { VTI: -1 } }],
    [{ ...good, holdings: { VTI: Infinity } }],
    [{ ...good, entries: [{ ...e('2026-09'), month: '2026-13' }] }],
    [{ ...good, entries: [{ ...e('2026-09'), amount: 0 }] }],
    [{ ...good, entries: [{ ...e('2026-09'), note: 'x'.repeat(121) }] }],
    ['not an object'],
  ])('rejects a damaged backup (%#)', (bad) => {
    expect(() => parseData(bad)).toThrow()
  })
})

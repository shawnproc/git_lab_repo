// Same numbers as backend/tests/test_watch_valuation.py, so the phone and Python agree.
import { describe, expect, it } from 'vitest'
import { encryptBackup, isEncrypted, openBackup } from '../phone/backup'
import { buildTargets, type PlanTarget, sleeveWeights, splitContribution } from '../phone/logic'
import type { History } from '../phone/portfolio'
import { sleeveVsIndex } from '../phone/sleeve'
import { freshness, type Session } from '../phone/stale'
import { empty, type PhoneData } from '../phone/store'

const T = (symbol: string, kind: 'core' | 'stock', target_pct: number): PlanTarget => ({ symbol, name: symbol, kind, target_pct, why: '' })

describe('allocation math (matches Python)', () => {
  it('caps a share and redistributes the excess', () => {
    expect(sleeveWeights(40, [3, 1, 1, 1], 8)).toEqual([8, 8, 8, 8])
    const w = sleeveWeights(40, [2, 1, 1, 1, 1, 1, 1, 1, 1, 1], 8)
    expect(w[0]).toBeCloseTo((40 * 2) / 11)
    expect(w[1]).toBeCloseTo(40 / 11)
    expect(sleeveWeights(40, [1, 1], 8).reduce((a, x) => a + x, 0)).toBeCloseTo(16)
  })

  it('follows your chosen split and always sums to 100%', () => {
    const core = [T('VTI', 'core', 45), T('VXUS', 'core', 15)]
    const funds = [{ symbol: 'VTI', weight_pct: 45 }, { symbol: 'VXUS', weight_pct: 15 }]
    const stocks = Array.from({ length: 10 }, (_, i) => ({ ...T(`S${String(i)}`, 'stock', 0), weight: 1 }))
    for (const pct of [40, 30, 20]) {
      const t = buildTargets(core, funds, stocks, pct, 8)
      expect(t.reduce((a, x) => a + x.target_pct, 0)).toBeCloseTo(100)
      expect(t.filter((x) => x.kind === 'stock').reduce((a, x) => a + x.target_pct, 0)).toBeCloseTo(pct)
    }
    const by = Object.fromEntries(buildTargets(core, funds, stocks, 20, 8).map((x) => [x.symbol, x.target_pct]))
    expect(by.VTI).toBeCloseTo(60)
    expect(by.VXUS).toBeCloseTo(20)
    expect(by.S0).toBeCloseTo(2)
  })

  it('buy-day money skips price-flagged holdings', () => {
    const targets = [T('VTI', 'core', 60), T('AAA', 'stock', 20), T('BBB', 'stock', 20)]
    const values = { VTI: 600, AAA: 0, BBB: 100 }
    const got = Object.fromEntries(splitContribution(300, targets, values, new Set(['AAA'])).allocations.map((a) => [a.symbol, a.amount]))
    expect(got.AAA).toBeUndefined()
    expect(Object.values(got).reduce((a, x) => a + x, 0)).toBeCloseTo(300)
    expect(got.BBB).toBeGreaterThan(0)
    const all = splitContribution(100, targets, values, new Set(['VTI', 'AAA', 'BBB'])).allocations
    expect(all.reduce((a, x) => a + x.amount, 0)).toBeCloseTo(100)
  })
})

describe('sleeve vs the index', () => {
  const history: History = {
    days: ['d1', 'd2', 'd3'],
    closes: { VTI: [100, 100, 110], AAA: [10, 10, 20], VXUS: [50, 50, 50] },
  }
  it('compares your stocks with the same dollars put into VTI on the same days', () => {
    const trades = [
      { day: 'd1', symbol: 'AAA', qty: 10 }, // $100 on day 1
      { day: 'd2', symbol: 'AAA', qty: 10 }, // $100 more on day 2
      { day: 'd1', symbol: 'VXUS', qty: 1 }, // core fund: not part of the sleeve
    ]
    const r = sleeveVsIndex(trades, history, new Set(['VTI', 'VXUS']), 'VTI')
    expect(r).not.toBeNull()
    if (!r) return
    expect(r.start_value).toBe(100)
    expect(r.net_added).toBe(100)
    expect(r.sleeve_value).toBe(400) // 20 shares x $20
    expect(r.shadow_value).toBe(220) // 2 VTI shares x $110
    expect(r.sleeve_gain).toBe(200)
    expect(r.shadow_gain).toBe(20)
    expect(r.symbols).toEqual(['AAA'])
  })
  it('lists stocks it can’t price instead of guessing, and needs some stocks', () => {
    const r = sleeveVsIndex([{ day: 'd1', symbol: 'AAA', qty: 1 }, { day: 'd1', symbol: 'ZZZ', qty: 1 }], history, new Set(['VTI']), 'VTI')
    expect(r?.left_out).toEqual(['ZZZ'])
    expect(sleeveVsIndex([{ day: 'd1', symbol: 'VTI', qty: 1 }], history, new Set(['VTI']), 'VTI')).toBeNull()
  })
})

describe('stale-data detection', () => {
  // Thu Oct 1 and Fri Oct 2 closes, then Mon Oct 5 and Tue Oct 6 (4pm ET = 20:00 UTC).
  const sessions: Session[] = ['2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07'].map((day) => ({ day, close: `${day}T20:00:00+00:00` }))
  const at = (iso: string) => new Date(iso)
  it('is fresh over a weekend and one day behind before the evening update', () => {
    expect(freshness(['2026-10-02'], sessions, null, at('2026-10-04T15:00:00Z')).stale).toBe(false)
    const mon = freshness(['2026-10-02'], sessions, null, at('2026-10-05T21:00:00Z'))
    expect(mon).toMatchObject({ stale: false, behind: 1 })
  })
  it('is stale after more than one market day without an update', () => {
    const tue = freshness(['2026-10-02'], sessions, null, at('2026-10-06T21:00:00Z'))
    expect(tue.stale).toBe(true)
    expect(tue.reason).toMatch(/2 market days old/)
  })
  it('the oldest plan price counts', () => {
    expect(freshness(['2026-10-06', '2026-10-01'], sessions, null, at('2026-10-06T21:00:00Z')).behind).toBe(3)
  })
  it('a failed update check, a missing calendar, or a very old file is stale', () => {
    const bad = { ok: false, checked_at: '', published_generated_at: null, kept_previous: true, errors: ['VTI: price is missing or zero'] }
    expect(freshness(['2026-10-02'], sessions, bad, at('2026-10-02T21:00:00Z')).reason).toMatch(/VTI: price is missing/)
    expect(freshness(['2026-10-02'], undefined, null, at('2026-10-02T21:00:00Z')).stale).toBe(true)
    expect(freshness(['2026-10-02'], sessions, null, at('2026-11-02T21:00:00Z')).stale).toBe(true)
    expect(freshness([], sessions, null, at('2026-10-02T21:00:00Z')).stale).toBe(true)
  })
})

describe('encrypted backup', () => {
  const data: PhoneData = { ...empty(), shares: { VTI: 2.5 }, holdings: { ZZZ: 40 }, entries: [{ id: 'a1', month: '2026-09', amount: 75, note: '', created_at: '2026-09-15T12:00:00.000Z' }] }
  const FAST = 100_000 // the minimum the app accepts; keeps the test quick

  it('round-trips with the passphrase and hides everything without it', async () => {
    const file = await encryptBackup(data, 'correct horse battery', new Date('2026-10-05T12:00:00Z'), FAST)
    expect(isEncrypted(JSON.parse(file))).toBe(true)
    expect(file).not.toContain('VTI')
    expect(file).not.toContain('ZZZ')
    const back = await openBackup(file, 'correct horse battery')
    expect(back.data).toEqual(data)
    expect(back.encrypted).toBe(true)
    expect(back.saved_at).toBe('2026-10-05T12:00:00.000Z')
  })

  it('a wrong passphrase or a changed file restores nothing', async () => {
    const file = await encryptBackup(data, 'correct horse battery', new Date(), FAST)
    await expect(openBackup(file, 'wrong passphrase!!')).rejects.toThrow(/Wrong passphrase/)
    const env = JSON.parse(file) as { data: string; saved_at: string }
    const flipped = JSON.stringify({ ...env, data: (env.data[0] === 'A' ? 'B' : 'A') + env.data.slice(1) })
    await expect(openBackup(flipped, 'correct horse battery')).rejects.toThrow(/changed or damaged/)
    const header = JSON.stringify({ ...env, saved_at: '2020-01-01T00:00:00.000Z' }) // header is sealed too
    await expect(openBackup(header, 'correct horse battery')).rejects.toThrow(/changed or damaged/)
  })

  it('refuses short passphrases and weakened files; still opens old plain backups', async () => {
    await expect(encryptBackup(data, 'short')).rejects.toThrow(/at least 10/)
    const file = JSON.parse(await encryptBackup(data, 'correct horse battery', new Date(), FAST)) as { kdf: { iterations: number } }
    file.kdf.iterations = 1000
    await expect(openBackup(JSON.stringify(file), 'correct horse battery')).rejects.toThrow(/can’t open/)
    const plain = await openBackup(JSON.stringify(data), null)
    expect(plain.encrypted).toBe(false)
    expect(plain.data.shares).toEqual({ VTI: 2.5 })
  })
})

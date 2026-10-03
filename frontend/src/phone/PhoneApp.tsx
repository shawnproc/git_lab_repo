import { type ChangeEvent, type SubmitEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { localMonth, type Learn, type MoodResult, type Plan as PlanData, type ScreenResult } from '../api'
import { KeystoneLogo, MoodArch, SpiritLevel } from '../components/brand'
import { GrowingWall, WallStats } from '../components/GrowingWall'
import { Card, Explain, PageHeader } from '../components/ui'
import { fmtMoney, fmtMonth, fmtPct, fmtShares, fmtSignedPct, fmtTimestamp, gainClass } from '../format'
import { LearnView } from '../pages/Learn'
import { PlanView } from '../pages/Plan'
import { type Theme, applyTheme, loadTheme } from '../theme'
import { buildWall, drift, type DriftRules, type PlanTarget, splitContribution } from './logic'
import { askPersistent, backupBlob, load, newId, type PhoneData, readBackup, save } from './store'

// ---------------------------------------------------------------------------------------------
// Snapshot: public market data, rebuilt every weekday by GitHub Actions.

interface Section {
  source: string
  fetched_at: string | null
  stale: boolean
  reason: string
  last_error: string
}

export interface Quote {
  close: number
  prev_close: number | null
  change_pct: number | null
  day: string
}

export interface Snapshot {
  schema: 1
  generated_at: string
  mood: Section & { result: MoodResult; index_day: string | null; vix_day: string | null }
  plan: Section & { targets: PlanTarget[]; screen: ScreenResult[] }
  /** Optional: snapshots built before prices were added don't have it. */
  prices?: Section & { quotes: Record<string, Quote>; missing: string[] }
  rules: { drift: DriftRules }
  learn: Learn
}

const MAX_AGE_DAYS = 4 // a long weekend plus a missed run

async function fetchSnapshot(): Promise<Snapshot> {
  const res = await fetch('./snapshot.json', { cache: 'no-cache', credentials: 'omit', redirect: 'error' })
  if (!res.ok) throw new Error(`Couldn’t load today’s data (${String(res.status)}).`)
  const data = (await res.json()) as Partial<Snapshot>
  if (data.schema !== 1 || !data.mood || !data.plan || !data.learn) throw new Error('Today’s data file looks damaged.')
  return data as Snapshot
}

function ageDays(iso: string): number {
  return (Date.now() - Date.parse(iso)) / 86_400_000
}

function Stamp({ snap }: { snap: Snapshot }) {
  const problems: string[] = []
  if (ageDays(snap.generated_at) > MAX_AGE_DAYS) problems.push(`Data was last updated ${fmtTimestamp(snap.generated_at)}.`)
  if (snap.mood.stale) problems.push(`Market mood: ${snap.mood.reason}`)
  if (snap.plan.stale) problems.push(`Company reports: ${snap.plan.reason}`)
  if (snap.prices?.stale) problems.push(`Ticker prices: ${snap.prices.reason}`)
  if (problems.length === 0) return null
  return (
    <div role="alert" className="stamp mb-6 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="stamp-label">Stale data</span>
        <span className="font-bold">Some numbers are old. Don’t act on them yet.</span>
      </div>
      <ul className="mt-2 space-y-1 text-sm">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
      <p className="muted mt-2 text-xs">The data updates by itself every weekday evening. If this stays, check the “Daily data” job on GitHub.</p>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Pages

const MOOD_LABEL = { green: 'Green', yellow: 'Yellow', red: 'Red', unknown: 'Not enough data yet' } as const

function Today({ snap, data }: { snap: Snapshot; data: PhoneData }) {
  const wall = buildWall(data.entries, localMonth())
  const m = snap.mood.result
  return (
    <div className="space-y-5">
      <PageHeader title="Today" intro={`Market data from the close on ${snap.mood.index_day ? fmtMonthDay(snap.mood.index_day) : '—'}.`} />
      <Stamp snap={snap} />
      <Card>
        <MoodArch mood={m.mood} />
        <div className="eyebrow mt-4">Market mood</div>
        <div className="serif text-4xl font-bold">{MOOD_LABEL[m.mood]}</div>
        <p className="serif mt-2 text-lg leading-snug">{m.headline}</p>
        <ul className="mt-3 space-y-2 text-sm">{m.reasons.map((r) => <li key={r} className="border-l-2 border-[var(--line)] pl-3">{r}</li>)}</ul>
        <Explain>
          <p>A <b>weather report</b> for the stock market, not a buy or sell signal.</p>
          <p><b>Direction:</b> is the S&amp;P 500 (the 500 biggest US companies) above its average of the last ~10 months? Above means it’s been rising.</p>
          <p><b>Nerves:</b> the VIX “fear gauge”. Under 20 is calm, 20–30 nervous, over 30 scared.</p>
          <p><b>For long-term investing the move is usually the same in every color: keep adding money each month.</b></p>
          <p className="muted text-xs">Source: {snap.mood.source}, fetched {fmtTimestamp(snap.mood.fetched_at)}.</p>
        </Explain>
      </Card>
      <Tickers snap={snap} />
      <Card title="This month">
        <p className="serif text-lg">{wall.message}</p>
        <a href="#/invest" className="btn mt-4 w-full">{wall.this_month_laid ? 'Add more this month' : 'Invest this month'} →</a>
        <div className="mt-5"><GrowingWall wall={wall} maxYears={2} /></div>
      </Card>
    </div>
  )
}

function Tickers({ snap }: { snap: Snapshot }) {
  const quotes = snap.prices?.quotes ?? {}
  const days = [...new Set(Object.values(quotes).map((q) => q.day))].sort()
  const last = days.at(-1)
  return (
    <Card title="Your plan’s tickers">
      {snap.plan.targets.length === 0 ? <p className="muted text-sm">No plan yet.</p> : (
        <ul className="divide-y divide-[var(--line)]">
          {snap.plan.targets.map((t) => {
            const q = quotes[t.symbol]
            const up = (q?.change_pct ?? 0) > 0
            const down = (q?.change_pct ?? 0) < 0
            return (
              <li key={t.symbol} className="flex items-center gap-3 py-2 text-sm">
                <span className="w-14 font-mono font-bold">{t.symbol}</span>
                <span className="muted min-w-0 flex-1 truncate text-xs">{t.name}</span>
                {q ? (
                  <>
                    <span className="font-mono">{fmtMoney(q.close)}</span>
                    <span className={`w-20 text-right font-mono ${gainClass(q.change_pct)}`}>
                      <span aria-hidden>{up ? '▲ ' : down ? '▼ ' : ''}</span>{fmtSignedPct(q.change_pct)}
                    </span>
                  </>
                ) : <span className="muted text-xs">no price today</span>}
              </li>
            )
          })}
        </ul>
      )}
      <Explain>
        <p><b>Last close</b> is the price when the market closed{last ? ` on ${fmtMonthDay(last)}` : ''}. The <b>%</b> is the change from the day before: ▲ up, ▼ down.</p>
        <p>Prices wiggle every day. That’s normal and <b>not a reason to buy or sell</b>. Your plan works on months and years, not days.</p>
        <p className="muted text-xs">Source: {snap.prices ? `${snap.prices.source}, fetched ${fmtTimestamp(snap.prices.fetched_at)}` : 'not available yet'}. Your own values come from your broker app.</p>
      </Explain>
    </Card>
  )
}

function fmtMonthDay(day: string): string {
  const d = new Date(`${day}T12:00:00Z`)
  return Number.isNaN(d.getTime()) ? day : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
}

function Invest({ snap, data, update }: { snap: Snapshot; data: PhoneData; update: (d: PhoneData) => void }) {
  const targets = snap.plan.targets
  const symbols = useMemo(() => [...new Set([...targets.map((t) => t.symbol), ...Object.keys(data.holdings)])], [targets, data.holdings])
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(symbols.map((s) => [s, data.holdings[s] !== undefined ? String(data.holdings[s]) : ''])))
  const [extra, setExtra] = useState('')
  const [saved, setSaved] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [amount, setAmount] = useState('500')
  const [split, setSplit] = useState<ReturnType<typeof splitContribution> | null>(null)
  const [addToHoldings, setAddToHoldings] = useState(true)
  const [laid, setLaid] = useState(false)

  const rows = drift(targets, data.holdings, snap.rules.drift)
  const flagged = rows.filter((r) => r.flagged).length
  const hasValues = Object.keys(data.holdings).length > 0

  function saveValues(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault()
    const next: Record<string, number> = {}
    for (const [s, raw] of Object.entries(values)) {
      const txt = raw.replace(/[$,\s]/g, '')
      if (!txt) continue
      const n = Number(txt)
      if (!Number.isFinite(n) || n < 0) {
        setProblem(`“${raw}” for ${s} isn’t a dollar amount. Type something like 1250.50.`)
        return
      }
      if (n > 0) next[s] = n
    }
    setProblem(null)
    update({ ...data, holdings: next, values_as_of: new Date().toISOString() })
    setSaved(true)
  }

  function addSymbol() {
    const s = extra.trim().toUpperCase()
    if (!/^\^?[A-Z0-9]{1,10}([.-][A-Z0-9]{1,4})?$/.test(s)) {
      setProblem(`“${extra}” doesn’t look like a ticker symbol (like VTI or AAPL).`)
      return
    }
    setProblem(null)
    setValues({ ...values, [s]: values[s] ?? '' })
    setExtra('')
  }

  function doSplit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault()
    const n = Number(amount.replace(/[$,\s]/g, ''))
    if (!Number.isFinite(n) || n <= 0) {
      setProblem('Type the amount you’re adding, like 500.')
      return
    }
    setProblem(null)
    setLaid(false)
    setSplit(splitContribution(n, targets, data.holdings))
  }

  function layStone() {
    if (!split) return
    const total = split.allocations.reduce((a, x) => a + x.amount, 0)
    const holdings = { ...data.holdings }
    if (addToHoldings) for (const a of split.allocations) holdings[a.symbol] = Math.round(((holdings[a.symbol] ?? 0) + a.amount) * 100) / 100
    update({
      ...data,
      holdings,
      values_as_of: addToHoldings ? new Date().toISOString() : data.values_as_of,
      entries: [...data.entries, { id: newId(), month: localMonth(), amount: Math.round(total * 100) / 100, note: '', created_at: new Date().toISOString() }],
    })
    if (addToHoldings) {
      const updated = { ...values }
      for (const [k, v] of Object.entries(holdings)) updated[k] = String(v)
      setValues(updated)
    }
    setLaid(true)
  }

  return (
    <div className="space-y-5">
      <PageHeader title="Invest" intro="Three steps, about two minutes. Keep your broker app open alongside." />
      <Stamp snap={snap} />

      <Card title="1 · What your holdings are worth">
        <p className="muted mb-3 text-sm">
          Open your broker app and copy the <b>current value</b> of each one. Leave blank what you don’t own.
          {data.values_as_of && ` Last updated ${fmtTimestamp(data.values_as_of)}.`}
        </p>
        <form onSubmit={saveValues} className="space-y-2">
          {symbols.concat(Object.keys(values).filter((s) => !symbols.includes(s))).map((s) => {
            const t = targets.find((x) => x.symbol === s)
            return (
              <label key={s} className="flex items-center gap-3">
                <span className="w-16 font-mono font-bold">{s}</span>
                <span className="muted hidden flex-1 truncate text-xs sm:inline">{t ? t.name : 'not in your plan'}</span>
                <span className="font-mono">$</span>
                <input className="input w-36" inputMode="decimal" placeholder="0" value={values[s] ?? ''} aria-label={`${s} value in dollars`}
                  onChange={(e) => { setSaved(false); setValues({ ...values, [s]: e.target.value }) }} />
              </label>
            )
          })}
          <div className="flex gap-2 pt-1">
            <input className="input w-28 font-mono uppercase" placeholder="OTHER" value={extra} maxLength={16} aria-label="Add another ticker"
              onChange={(e) => { setExtra(e.target.value) }} />
            <button type="button" className="btn btn-ghost" onClick={addSymbol}>+ Add</button>
            <button className="btn ml-auto">Save values</button>
          </div>
          {saved && <p className="text-sm text-[var(--color-up)]">✓ Saved on this phone</p>}
        </form>
        {hasValues && (
          <div className="mt-5">
            <p className="mb-2 text-sm">{flagged === 0 ? '✅ Close to your plan.' : `⚠️ ${String(flagged)} drifted. This month’s split below fixes it gradually.`}</p>
            <ul className="space-y-2">
              {rows.map((r) => (
                <li key={r.symbol} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                  <span className="w-14 font-mono font-bold">{r.symbol}</span>
                  {r.kind === 'off_plan' ? <span className="muted text-xs">not in plan</span> : <SpiritLevel diffPp={r.diff_pp} flagged={r.flagged} />}
                  <span className="font-mono">{fmtPct(r.actual_pct)} <span className="muted">/ {fmtPct(r.target_pct)}</span></span>
                  {r.reason && <span className={`w-full pl-[4.25rem] text-xs ${r.flagged ? 'text-[var(--color-warn)]' : 'muted'}`}>{r.reason}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
        <Explain title="Why type the values?">
          <p>Your broker app already shows exactly what each holding is worth right now, which is more accurate than any free price feed. Typing them in takes a minute and keeps this app simple and private.</p>
          <p>The <b>level</b> shows each holding against its target: middle line = target, bubble = you. Green inside the ±5-point marks, amber outside.</p>
        </Explain>
      </Card>

      <Card title="2 · Split this month’s money">
        <form onSubmit={doSplit} className="flex items-end gap-2">
          <label className="flex-1 text-sm">
            How much are you adding?
            <div className="mt-1 flex items-center gap-1"><span className="font-mono text-lg">$</span>
              <input className="input font-mono" inputMode="decimal" value={amount} aria-label="Amount to add in dollars"
                onChange={(e) => { setAmount(e.target.value) }} /></div>
          </label>
          <button className="btn">Split it</button>
        </form>
        {split && (
          <div className="mt-4">
            <ol className="slip space-y-3 px-4 pb-4">
              {split.allocations.map((a, i) => {
                const q = snap.prices?.quotes[a.symbol]
                return (
                  <li key={a.symbol}>
                    <div className="flex items-end">
                      <span className="serif text-lg"><span className="muted mr-2 font-mono text-sm">{String(i + 1).padStart(2, '0')}</span>Buy <b className="font-mono">{a.symbol}</b></span>
                      <span className="leader" aria-hidden />
                      <b className="font-mono text-lg">{fmtMoney(a.amount)}</b>
                    </div>
                    {q && <div className="muted pl-8 text-xs">≈ {fmtShares(a.amount / q.close)} shares at the last close of {fmtMoney(q.close)}</div>}
                  </li>
                )
              })}
            </ol>
            {!hasValues && <p className="muted mt-2 text-xs">No holdings values yet, so this follows your plan’s targets exactly.</p>}
            <p className="muted mt-2 text-xs">In your broker app, choose to buy <b>in dollars</b> and type each amount. Share counts are estimates: today’s price will be a little different.</p>
          </div>
        )}
        <Explain title="How is it split?">
          <p>Money goes to whatever is furthest <b>below</b> its target first, so you never need to sell to stay on plan.</p>
        </Explain>
      </Card>

      <Card title="3 · Lay this month’s stone">
        {!split ? (
          <p className="muted text-sm">Split your money above, buy it in your broker app, then come back here.</p>
        ) : laid ? (
          <p className="font-semibold text-[var(--color-up)]">✓ Stone laid for {fmtMonth(`${localMonth()}-01`)}. <a className="underline" href="#/wall">See your wall</a>.</p>
        ) : (
          <>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={addToHoldings} onChange={(e) => { setAddToHoldings(e.target.checked) }} />
              Also add these amounts to my holdings values
            </label>
            <button className="btn mt-3 w-full" onClick={layStone}>
              I invested {fmtMoney(split.allocations.reduce((a, x) => a + x.amount, 0))}. Lay the stone
            </button>
          </>
        )}
      </Card>
      {problem && <p role="alert" className="fixed inset-x-4 bottom-24 z-20 border-l-4 border-[var(--color-down)] bg-[var(--panel)] p-3 text-sm shadow-xl">{problem}</p>}
    </div>
  )
}

function PlanPage({ snap, data }: { snap: Snapshot; data: PhoneData }) {
  const total = Object.values(data.holdings).reduce((a, v) => a + v, 0)
  const basis = total > 0 ? total : 10_000
  const plan: PlanData = {
    targets: snap.plan.targets.map((t) => ({ ...t, target_value: Math.round((t.target_pct / 100) * basis * 100) / 100 })),
    screen: snap.plan.screen,
    fundamentals: { source: snap.plan.source, fetched_at: snap.plan.fetched_at, stale: snap.plan.stale, reason: snap.plan.reason, last_error: snap.plan.last_error },
    basis_value: basis,
    basis_is_reference: total <= 0,
  }
  return (
    <div>
      <PageHeader title="My Plan" intro="What to own and why. Updated from companies’ official reports." />
      <Stamp snap={snap} />
      <PlanView data={plan} />
    </div>
  )
}

function WallPage({ data, update }: { data: PhoneData; update: (d: PhoneData) => void }) {
  const wall = buildWall(data.entries, localMonth())
  const [month, setMonth] = useState(localMonth())
  const [amount, setAmount] = useState('')
  const [msg, setMsg] = useState<string | null>(null)

  function log(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault()
    const n = Number(amount.replace(/[$,\s]/g, ''))
    if (!/^\d{4}-\d{2}$/.test(month) || month > localMonth()) {
      setMsg('Pick a month that has already started.')
      return
    }
    if (!Number.isFinite(n) || n <= 0 || n > 1e7) {
      setMsg('Type the amount you invested, like 500.')
      return
    }
    update({ ...data, entries: [...data.entries, { id: newId(), month, amount: Math.round(n * 100) / 100, note: '', created_at: new Date().toISOString() }] })
    setAmount('')
    setMsg('✓ Stone laid.')
  }

  async function restore(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try {
      const d = await readBackup(file)
      if (!confirm(`Replace what’s on this phone with the backup (${String(d.entries.length)} stones, ${String(Object.keys(d.holdings).length)} holdings)?`)) return
      update(d)
      setMsg('✓ Backup restored.')
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Couldn’t read that file.')
    }
  }

  async function backup() {
    const blob = backupBlob(data)
    const name = `keystone-backup-${new Date().toISOString().slice(0, 10)}.json`
    const file = new File([blob], name, { type: 'application/json' })
    try {
      if ('canShare' in navigator && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'Keystone Ledger backup' })
        setMsg('✓ Backup shared. Save it to Files or iCloud Drive.')
        return
      }
    } catch {
      // share cancelled: fall through to a download
    }
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    URL.revokeObjectURL(url)
    setMsg('✓ Backup file saved.')
  }

  const recent = [...data.entries].sort((a, b) => (a.month < b.month ? 1 : -1)).slice(0, 24)
  return (
    <div className="space-y-5">
      <PageHeader title="My Wall" intro="One stone for every month you invest. A full year earns a keystone." />
      <Card>
        <p className="serif mb-4 text-lg">{wall.message}</p>
        <WallStats wall={wall} />
        <div className="mt-5"><GrowingWall wall={wall} /></div>
        <form onSubmit={log} className="mt-5 flex flex-wrap items-end gap-2">
          <label className="text-sm">Month<input className="input mt-1 w-40" type="month" value={month} max={localMonth()} min="1990-01"
            onChange={(e) => { setMonth(e.target.value) }} aria-label="Month you invested" /></label>
          <label className="text-sm">Amount<input className="input mt-1 w-28" inputMode="decimal" placeholder="500" value={amount}
            onChange={(e) => { setAmount(e.target.value) }} aria-label="Amount you invested in dollars" /></label>
          <button className="btn">Lay a stone</button>
        </form>
        {recent.length > 0 && (
          <details className="mt-4">
            <summary className="cursor-pointer text-sm font-semibold">Your log</summary>
            <ul className="mt-2 divide-y divide-[var(--line)] text-sm">
              {recent.map((en) => (
                <li key={en.id} className="flex items-center gap-3 py-2">
                  <span className="flex-1 font-mono">{fmtMonth(`${en.month}-01`)}</span>
                  <span className="font-mono font-semibold">{fmtMoney(en.amount)}</span>
                  <button className="btn btn-ghost px-2 py-1 text-xs" aria-label={`Remove ${fmtMoney(en.amount)} from ${fmtMonth(`${en.month}-01`)}`}
                    onClick={() => { update({ ...data, entries: data.entries.filter((x) => x.id !== en.id) }) }}>Remove</button>
                </li>
              ))}
            </ul>
          </details>
        )}
      </Card>
      <Card title="Back up your wall">
        <p className="text-sm">Your holdings and stones live <b>only on this phone</b>. Save a backup now and then, so a lost or new phone doesn’t mean starting over.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button className="btn" onClick={() => void backup()}>Save a backup</button>
          <label className="btn btn-ghost cursor-pointer">Restore a backup
            <input type="file" accept="application/json,.json" className="sr-only" onChange={(e) => void restore(e)} />
          </label>
        </div>
      </Card>
      {msg && <p role="status" className="text-sm">{msg}</p>}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Shell

const TABS = [
  { id: 'today', label: 'Today', icon: 'M3 20h18M5 20v-6a7 7 0 0 1 14 0v6M10 7l2-3 2 3' },
  { id: 'invest', label: 'Invest', icon: 'M12 3v18M7 8h7a3 3 0 0 1 0 6H9a3 3 0 0 0 0 6h8' },
  { id: 'plan', label: 'Plan', icon: 'M3 20h18M4 20v-5h7v5M13 20v-9h7v9M8 15V9h8v2' },
  { id: 'wall', label: 'Wall', icon: 'M3 6h18v4H3zM3 14h18v4H3zM9 6v4M15 14v4M7 14v4' },
  { id: 'learn', label: 'Learn', icon: 'M4 5h7a3 3 0 0 1 3 3v12a2 2 0 0 0-2-2H4zM20 5h-6a3 3 0 0 0-3 3' },
] as const
type TabId = (typeof TABS)[number]['id']
const ALIAS: Record<string, TabId> = { home: 'today', money: 'invest' }

function tabFromHash(): TabId {
  const h = window.location.hash.replace(/^#\/?/, '')
  if (TABS.some((t) => t.id === h)) return h as TabId
  return ALIAS[h] ?? 'today'
}

export default function PhoneApp() {
  const [tab, setTab] = useState<TabId>(tabFromHash)
  const [theme, setTheme] = useState<Theme>(loadTheme)
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<PhoneData>(load)

  useEffect(() => { applyTheme(theme) }, [theme])
  useEffect(() => {
    const on = () => { setTab(tabFromHash()); window.scrollTo(0, 0) }
    window.addEventListener('hashchange', on)
    return () => { window.removeEventListener('hashchange', on) }
  }, [])
  useEffect(() => {
    fetchSnapshot().then(setSnap, (e: unknown) => { setError(e instanceof Error ? e.message : 'Couldn’t load today’s data.') })
    void askPersistent()
  }, [])

  const update = useCallback((d: PhoneData) => {
    setData(d)
    if (!save(d)) setError('Couldn’t save on this phone (storage full or private mode). Save a backup.')
  }, [])

  return (
    <div className="flex min-h-screen flex-col" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
      <header className="mx-auto flex w-full max-w-2xl items-center justify-between px-4 pt-4">
        <div className="flex items-center gap-2">
          <KeystoneLogo size={30} />
          <span className="serif text-lg font-bold">Keystone Ledger</span>
        </div>
        <button className="btn btn-ghost px-2 py-1 text-xs" aria-label="Toggle theme" onClick={() => { setTheme(theme === 'dark' ? 'light' : 'dark') }}>
          {theme === 'dark' ? '▤ Ledger' : '▦ Blueprint'}
        </button>
      </header>
      <main className="mx-auto w-full max-w-2xl flex-1 px-4 pb-32 pt-6">
        {error && <p role="alert" className="mb-4 border-l-4 border-[var(--color-down)] p-3 text-sm">{error}</p>}
        {!snap && !error && <p className="muted">Loading today’s data…</p>}
        {snap && tab === 'today' && <Today snap={snap} data={data} />}
        {snap && tab === 'invest' && <Invest snap={snap} data={data} update={update} />}
        {snap && tab === 'plan' && <PlanPage snap={snap} data={data} />}
        {tab === 'wall' && <WallPage data={data} update={update} />}
        {snap && tab === 'learn' && (
          <div><PageHeader title="Learn" intro="Every word the app uses, in plain English." /><LearnView data={snap.learn} /></div>
        )}
        <p className="muted mt-10 text-center text-xs">
          Educational tool, not financial advice. Your holdings and wall stay on this phone. {snap && `Data updated ${fmtTimestamp(snap.generated_at)}.`}
        </p>
      </main>
      <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-10 border-t-2 border-[var(--ink)] bg-[var(--panel)]"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
        <div className="mx-auto flex max-w-2xl">
          {TABS.map((t) => (
            <a key={t.id} href={`#/${t.id}`} aria-current={tab === t.id ? 'page' : undefined}
              className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-[0.7rem] font-semibold ${tab === t.id ? 'text-[var(--color-brand-2)]' : 'muted'}`}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={t.icon} /></svg>
              {t.label}
            </a>
          ))}
        </div>
      </nav>
    </div>
  )
}

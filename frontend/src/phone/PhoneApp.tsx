import { type ChangeEvent, createContext, type SubmitEvent, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { localMonth, type Plan as PlanData } from '../api'
import { KeystoneLogo, MoodArch, SpiritLevel } from '../components/brand'
import { Card, Explain, PageHeader } from '../components/ui'
import { fmtDay, fmtMoney, fmtPct, fmtShares, fmtSignedMoney, fmtSignedPct, fmtTimestamp, gainClass } from '../format'
import { ValueChart } from '../components/ValueChart'
import { LearnView } from '../pages/Learn'
import { PlanView } from '../pages/Plan'
import { type Theme, applyTheme, loadTheme } from '../theme'
import { drift, splitContribution } from './logic'
import { accountSeries, belowHigh, change, chartable, flowsBetween, type History, holdingValues, inRange, type Point, type Quote, RANGES, type Range, tickerSeries, valueSeries } from './portfolio'
import { type ImportResult, parseRobinhood, type Trade } from './robinhood'
import { buyStatus, CADENCE_WORDS, CADENCES, type Cadence, defaultSchedule, type Schedule } from './schedule'
import { BackupCard, BackupReminder, CompanyStatus, FreshnessBar, OverlapCard, SleeveCard, SplitSetting, TopThree } from './Insights'
import { freshnessOf, type Snapshot, skipFor, targetsFor } from './model'
import type { Freshness, RefreshStatus } from './stale'
import { fetchResearch, type Research } from './research'
import { phoneWatch, SearchPage } from './Search'
import { LiveProvider, useLive } from './LiveContext'
import { LiveNow } from './LiveNow'
import { askPersistent, load, newId, type PhoneData, save } from './store'

// ---------------------------------------------------------------------------------------------
// Snapshot: public market data, rebuilt every weekday by GitHub Actions.

export type { Snapshot } from './model'

/** Today's search data (null until loaded or if it failed), for included Search picks. */
const ResearchCtx = createContext<Research | null>(null)
const useTargets = (snap: Snapshot, data: PhoneData) => targetsFor(snap, data, useContext(ResearchCtx))

const MAX_AGE_DAYS = 4 // a long weekend plus a missed run
const NO_HISTORY: History = { days: [], closes: {} }

const quotesOf = (snap: Snapshot): Record<string, Quote> => snap.prices?.quotes ?? {}
const historyOf = (snap: Snapshot): History => snap.prices?.history ?? NO_HISTORY
const localDay = () => {
  const d = new Date()
  return `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const IMPORT_NOTE = 'Robinhood import'
const tradedTotal = (trades: Trade[], sym: string) => Math.round(trades.filter((t) => t.symbol === sym).reduce((a, t) => a + t.qty, 0) * 1e6) / 1e6

/** Log a buy (for your buy-day status) and, optionally, the shares/dollars added to what you own.
 * Tickers with a price track shares (estimated at the last close); others track dollars. */
function recordBuy(data: PhoneData, allocations: { symbol: string; amount: number }[], quotes: Record<string, Quote>, addToHoldings: boolean): PhoneData {
  const total = allocations.reduce((a, x) => a + x.amount, 0)
  const holdings = { ...data.holdings }
  const shares = { ...data.shares }
  const trades = [...data.trades]
  if (addToHoldings) {
    for (const a of allocations) {
      const q = quotes[a.symbol]
      if (q && holdings[a.symbol] === undefined) {
        const qty = Math.round((a.amount / q.close) * 1e6) / 1e6
        shares[a.symbol] = Math.round(((shares[a.symbol] ?? 0) + qty) * 1e6) / 1e6
        if (trades.length > 0) trades.push({ day: localDay(), symbol: a.symbol, qty, source: 'stone' })
      } else holdings[a.symbol] = Math.round(((holdings[a.symbol] ?? 0) + a.amount) * 100) / 100
    }
  }
  return {
    ...data,
    holdings,
    shares,
    trades,
    values_as_of: addToHoldings ? new Date().toISOString() : data.values_as_of,
    entries: [...data.entries, { id: newId(), month: localMonth(), amount: Math.round(total * 100) / 100, note: '', created_at: new Date().toISOString() }],
  }
}

/** Local days you logged buys yourself (imported history doesn't count toward this period). */
const buyDays = (data: PhoneData) => data.entries.filter((e) => e.note !== IMPORT_NOTE).map((e) => {
  const d = new Date(e.created_at)
  return `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
})

const valuesOf = (snap: Snapshot, data: PhoneData) => holdingValues(data.shares, data.holdings, quotesOf(snap))

async function fetchSnapshot(): Promise<Snapshot> {
  const res = await fetch('./snapshot.json', { cache: 'no-cache', credentials: 'omit', redirect: 'error' })
  if (!res.ok) throw new Error(`Couldn’t load today’s data (${String(res.status)}).`)
  const data = (await res.json()) as Partial<Snapshot>
  if (data.schema !== 1 || !data.mood || !data.plan || !data.learn) throw new Error('Today’s data file looks damaged.')
  return data as Snapshot
}

/** The daily job's own report of whether today's update passed its checks (optional). */
async function fetchStatus(): Promise<RefreshStatus | null> {
  const res = await fetch('./status.json', { cache: 'no-cache', credentials: 'omit', redirect: 'error' })
  if (!res.ok) return null
  const s = (await res.json()) as Partial<RefreshStatus>
  return typeof s.ok === 'boolean' && Array.isArray(s.errors) ? (s as RefreshStatus) : null
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

function Today({ snap, data, theme, update, fresh, now }: { snap: Snapshot; data: PhoneData; theme: Theme; update: (d: PhoneData) => void; fresh: Freshness; now: Date }) {
  const m = snap.mood.result
  const targets = useTargets(snap, data)
  return (
    <div className="space-y-5">
      <FreshnessBar snap={snap} fresh={fresh} />
      <Stamp snap={snap} />
      <BackupReminder data={data} now={now} />
      <TodaysMove snap={snap} data={data} update={update} fresh={fresh} />
      <LiveNow shares={data.shares} quotes={quotesOf(snap)} />
      <TopThree snap={snap} data={data} targets={targets} fresh={fresh} />
      <YourMoney snap={snap} data={data} theme={theme} />
      <SleeveCard snap={snap} data={data} />
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
          <p><b>For long-term investing the move is the same in every color: keep adding money on schedule.</b> The mood never changes your buy days or amounts; it’s here only so you know what you’re seeing in the news.</p>
          <p className="muted text-xs">Source: {snap.mood.source}, fetched {fmtTimestamp(snap.mood.fetched_at)}.</p>
        </Explain>
      </Card>
      <Tickers snap={snap} theme={theme} />
    </div>
  )
}

const RANGE_WORDS: Record<Range, string> = { '1W': 'Past week', '1M': 'Past month', '3M': 'Past 3 months', YTD: 'This year', '1Y': 'Past year' }

/** Big number + change + scrubbable line + range buttons. Used for your money and each ticker. */
function RangeChart({ series, theme, eyebrow, label, defaultRange = '1Y' }: {
  series: Point[]; theme: Theme; eyebrow: string; label: string; defaultRange?: Range
}) {
  const [range, setRange] = useState<Range>(defaultRange)
  const [hover, setHover] = useState<Point | null>(null)
  const { points, base } = useMemo(() => inRange(series, range), [series, range])
  const last = points.at(-1)
  if (!last) return null
  const shown = hover ?? last
  const c = change(shown.value, base?.value ?? null)
  const up = (change(last.value, base?.value ?? null).amount ?? 0) >= 0
  const dir = (c.amount ?? 0) > 0 ? '▲' : (c.amount ?? 0) < 0 ? '▼' : ''
  // With a trade history, split the change into money you added and what the market did.
  const added = flowsBetween(points, base ?? null, shown)
  return (
    <div>
      <div className="eyebrow">{eyebrow}</div>
      <div className="serif text-5xl font-bold tabular-nums" aria-live="polite">{fmtMoney(shown.value)}</div>
      <div className={`mt-1 font-mono text-sm ${gainClass(c.amount)}`}>
        <span aria-hidden>{dir} </span>{fmtSignedMoney(c.amount)} ({fmtSignedPct(c.pct)})
        <span className="muted ml-2 font-sans">{hover ? `since ${fmtDay(base?.day ?? last.day)}` : RANGE_WORDS[range]}</span>
      </div>
      {added !== null && Math.abs(added) >= 0.01 && c.amount !== null && (
        <div className="mt-0.5 text-xs">
          <span className="muted">{added > 0 ? 'You added' : 'You took out'} {fmtMoney(Math.abs(added))} · the market moved </span>
          <span className={`font-mono ${gainClass(c.amount - added)}`}>{fmtSignedMoney(Math.round((c.amount - added) * 100) / 100)}</span>
        </div>
      )}
      <div className="muted text-xs">{hover ? fmtDay(hover.day) : `As of the close on ${fmtMonthDay(last.day)}`}</div>
      <div className="mt-3">
        <ValueChart points={points} base={base?.value ?? null} up={up} theme={theme} onHover={setHover} label={label} />
      </div>
      <div role="group" aria-label="Time range" className="mt-2 flex justify-between">
        {RANGES.map((r) => (
          <button key={r} type="button" aria-pressed={r === range} onClick={() => { setRange(r); setHover(null) }}
            className={`px-3 py-1 font-mono text-xs font-bold ${r === range ? 'bg-[var(--ink)] text-[var(--panel)]' : 'muted'}`}>{r}</button>
        ))}
      </div>
    </div>
  )
}

function TodaysMove({ snap, data, update, fresh }: { snap: Snapshot; data: PhoneData; update: (d: PhoneData) => void; fresh: Freshness }) {
  const today = localDay()
  const schedule = data.schedule ?? defaultSchedule(today)
  const [editing, setEditing] = useState(data.schedule === null)
  const [cadence, setCadence] = useState<Cadence>(schedule.cadence)
  const [amount, setAmount] = useState(String(schedule.amount))
  const [anchor, setAnchor] = useState(schedule.anchor)
  const [problem, setProblem] = useState<string | null>(null)
  const [justLogged, setJustLogged] = useState(false)
  const quotes = quotesOf(snap)
  const held = valuesOf(snap, data)
  const status = buyStatus(today, schedule, buyDays(data))
  // Mood is never an input here: buy days come from your schedule, amounts from your targets.
  const targets = useTargets(snap, data)
  const skip = skipFor(targets)
  const split = splitContribution(schedule.amount, targets, held, skip)
  const research = useContext(ResearchCtx)
  const waiting = research === null && data.watchlist.some((w) => w.include)

  function saveSchedule(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault()
    const n = Number(amount.replace(/[$,\s]/g, ''))
    if (!Number.isFinite(n) || n <= 0 || n > 1e6) { setProblem('Type the dollars for each buy day, like 75.'); return }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(anchor)) { setProblem('Pick your first buy day.'); return }
    setProblem(null)
    const next: Schedule = { cadence, amount: Math.round(n * 100) / 100, anchor }
    update({ ...data, schedule: next })
    setEditing(false)
  }

  function bought() {
    update(recordBuy(data, split.allocations, quotes, true))
    setJustLogged(true)
  }

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div className="eyebrow">Today’s move</div>
        {!editing && <button type="button" className="muted text-xs underline" onClick={() => { setEditing(true) }}>Change schedule</button>}
      </div>
      {waiting && <p className="mt-1 text-xs">Your Search picks aren’t in this split yet: today’s search data hasn’t loaded. They’re never added on an old verdict.</p>}
      {editing ? (
        <form onSubmit={saveSchedule} className="mt-2 space-y-3 text-sm">
          <p>Set your buy days to match your paydays. Steady buying on a schedule is the habit that grows money; guessing the “right day” usually doesn’t.</p>
          <label className="block">How often
            <select className="input mt-1 w-full" value={cadence} onChange={(e) => { setCadence(e.target.value as Cadence) }} aria-label="How often you buy">
              {CADENCES.map((c) => <option key={c} value={c}>{CADENCE_WORDS[c]}</option>)}
            </select>
          </label>
          {(cadence === 'weekly' || cadence === 'biweekly') && (
            <label className="block">First buy day (sets the weekday)
              <input className="input mt-1 w-full" type="date" value={anchor} onChange={(e) => { setAnchor(e.target.value) }} aria-label="First buy day" />
            </label>
          )}
          <label className="block">Dollars each buy day
            <div className="mt-1 flex items-center gap-1"><span className="font-mono text-lg">$</span>
              <input className="input font-mono" inputMode="decimal" value={amount} onChange={(e) => { setAmount(e.target.value) }} aria-label="Dollars each buy day" /></div>
          </label>
          {problem && <p role="alert" className="text-[var(--color-down)]">{problem}</p>}
          <button className="btn w-full">Save my schedule</button>
        </form>
      ) : status.due ? (
        <div className="mt-1">
          <div className="serif text-4xl font-bold">Buy day</div>
          <p className="mt-1 text-sm">Put in <b className="font-mono">{fmtMoney(schedule.amount)}</b> today. {CADENCE_WORDS[schedule.cadence]}; this one has been due since {fmtMonthDay(status.since)}.</p>
          {fresh.stale ? (
            <p role="alert" className="mt-3 border-l-4 border-[var(--color-warn)] p-3 text-sm">The amounts for each holding are hidden because the prices are out of date. Check back after the next update (weekday evenings), or buy your usual funds at your broker if you can’t wait.</p>
          ) : (<>
          <ol className="slip mt-3 space-y-2 px-4 pb-3">
            {split.allocations.map((a) => {
              const q = quotes[a.symbol]
              return (
                <li key={a.symbol} className="flex items-end text-sm">
                  <span>Buy <b className="font-mono">{a.symbol}</b>{q && <span className="muted text-xs"> ≈ {fmtShares(a.amount / q.close)} sh</span>}</span>
                  <span className="leader" aria-hidden />
                  <b className="font-mono">{fmtMoney(a.amount)}</b>
                </li>
              )
            })}
          </ol>
          <p className="muted mt-2 text-xs">In your broker app, buy each one <b>in dollars</b>. Money goes to whatever is furthest below its target, so you never have to sell.{skip.size > 0 && ` Skipped for now (price well above its usual level): ${[...skip].join(', ')}.`}</p>
          <button type="button" className="btn mt-3 w-full" onClick={bought}>I bought these</button>
          </>)}
        </div>
      ) : (
        <div className="mt-1">
          <div className="serif text-3xl font-bold">{justLogged ? '✓ Logged. Nice work.' : '✓ You’re done for now'}</div>
          <p className="mt-1 text-sm">Next buy day: <b>{fmtMonthDay(status.next)}</b> ({status.days_to_next === 1 ? 'tomorrow' : `in ${String(status.days_to_next)} days`}), {fmtMoney(schedule.amount)}.</p>
          <p className="muted mt-2 text-xs">Nothing to do today. Prices wiggle every day; your plan works on months and years. Checking in is fine, and acting on a wiggle is how people lose money.</p>
        </div>
      )}
      <Explain title="Why a schedule instead of “the best day”?">
        <p>Nobody can reliably tell which day is cheapest. People who try often wait too long and miss the market’s best days, which tend to come right after its worst ones.</p>
        <p>Buying the same amount on a steady schedule (called <b>dollar-cost averaging</b>) automatically buys more shares when prices are low and fewer when they’re high.</p>
        <p>The amount you put in matters far more than the day you pick: {fmtMoney(schedule.amount)} {schedule.cadence === 'weekly' ? 'every week' : schedule.cadence === 'biweekly' ? 'every 2 weeks' : schedule.cadence === 'semimonthly' ? 'twice a month' : 'a month'} is about <b>{fmtMoney(schedule.amount * ({ weekly: 52, biweekly: 26, semimonthly: 24, monthly: 12 } as const)[schedule.cadence], false)}</b> a year of new money.</p>
      </Explain>
    </Card>
  )
}

function YourMoney({ snap, data, theme }: { snap: Snapshot; data: PhoneData; theme: Theme }) {
  const history = historyOf(snap)
  const real = data.trades.length > 0
  const { series, syms } = useMemo(() => {
    if (real) {
      const a = accountSeries(data.shares, data.trades, history)
      return { series: a.points, syms: a.symbols }
    }
    const c = chartable(data.shares, history)
    return { series: valueSeries(data.shares, history, c), syms: c }
  }, [real, data.shares, data.trades, history])
  const values = valuesOf(snap, data)
  const outside = Object.keys(values).filter((s) => !syms.includes(s)).sort()
  const outsideTotal = outside.reduce((a, s) => a + (values[s] ?? 0), 0)
  if (series.length === 0) {
    return (
      <Card>
        <div className="eyebrow">Your money</div>
        {Object.keys(values).length > 0 && <div className="serif text-5xl font-bold">{fmtMoney(outsideTotal)}</div>}
        <p className="mt-2 text-sm">Type how many <b>shares</b> you own on the Invest tab and your chart appears here, updated every weekday.</p>
        <a href="#/invest" className="btn mt-4 w-full">Add my shares →</a>
      </Card>
    )
  }
  return (
    <Card>
      <RangeChart series={series} theme={theme} eyebrow="Your money" label="Line chart of what your shares were worth each day" />
      {outside.length > 0 && (
        <p className="muted mt-3 text-xs">Not on the line: {outside.join(', ')} ({fmtMoney(outsideTotal)}, typed in dollars, so there’s no daily price). Everything together: <b>{fmtMoney((series.at(-1)?.value ?? 0) + outsideTotal)}</b>.</p>
      )}
      <Explain>
        {real ? (
          <p>This is <b>your real history</b>: the shares you actually held each day (from your Robinhood report, plus anything you’ve added here since), times that day’s closing price. Cash isn’t included.</p>
        ) : (
          <>
            <p>The line shows what <b>the shares you own today</b> ({syms.join(', ')}) were worth at the end of each trading day.</p>
            <p>It doesn’t know when you bought them, so it isn’t your account history. <a className="underline" href="#/invest">Import your Robinhood report</a> to see the real one.</p>
          </>
        )}
        <p><b>Drag your finger across the line</b> to see any day. The dotted line is where the period started. ▲ green means up, ▼ red means down.</p>
        <p>Prices are the official closing prices, updated every weekday evening, not live. For long-term investing that’s all you need, and it saves you from watching every wiggle.</p>
      </Explain>
    </Card>
  )
}

function Tickers({ snap, theme }: { snap: Snapshot; theme: Theme }) {
  const [open, setOpen] = useState<string | null>(null)
  const live = useLive().quotes
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
              <li key={t.symbol} className="py-1 text-sm">
                <button type="button" className="flex w-full items-center gap-3 py-1 text-left" aria-expanded={open === t.symbol}
                  disabled={!q} onClick={() => { setOpen(open === t.symbol ? null : t.symbol) }}>
                  <span className="w-14 font-mono font-bold">{t.symbol}</span>
                  <span className="min-w-0 flex-1 text-xs">
                    <span className="muted block truncate">{t.name}</span>
                    {(() => {
                      const b = belowHigh(t.symbol, historyOf(snap))
                      if (!b) return null
                      return <span className="block text-[0.7rem]">{b.pct < 1 ? 'at its 1-yr high' : `${b.pct.toFixed(0)}% below 1-yr high`}</span>
                    })()}
                  </span>
                  {live[t.symbol] ? (() => {
                    const lq = live[t.symbol]
                    const c = lq?.change_pct ?? null
                    return (
                      <>
                        <span className="font-mono" title={`Live, ${fmtTimestamp(lq?.at ?? null)}`}><span className="text-[var(--color-up)]" aria-label="Live price">● </span>{fmtMoney(lq?.price ?? null)}</span>
                        <span className={`w-20 text-right font-mono ${gainClass(c)}`}>
                          <span aria-hidden>{(c ?? 0) > 0 ? '▲ ' : (c ?? 0) < 0 ? '▼ ' : ''}</span>{fmtSignedPct(c)}
                        </span>
                      </>
                    )
                  })() : q ? (
                    <>
                      <span className="font-mono">{fmtMoney(q.close)}</span>
                      <span className={`w-20 text-right font-mono ${gainClass(q.change_pct)}`}>
                        <span aria-hidden>{up ? '▲ ' : down ? '▼ ' : ''}</span>{fmtSignedPct(q.change_pct)}
                      </span>
                    </>
                  ) : <span className="muted text-xs">no price today</span>}
                </button>
                {open === t.symbol && (
                  <div className="pb-3 pt-2">
                    <RangeChart series={tickerSeries(t.symbol, historyOf(snap))} theme={theme} eyebrow={`${t.symbol} price`} label={`Line chart of ${t.symbol}'s closing price`} />
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
      <Explain>
        <p><b>Last close</b> is the price when the market closed{last ? ` on ${fmtMonthDay(last)}` : ''}. The <b>%</b> is the change from the day before: ▲ up, ▼ down.</p>
        <p><b>Tap a ticker</b> to see its chart.</p>
        <p><b>“% below its 1-year high”</b> shows how far today’s price is from its highest close in about a year. It’s context, like a sale tag: a stock can be cheaper for a good reason. It never changes your buy amounts.</p>
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

function RobinhoodImport({ snap, data, update }: { snap: Snapshot; data: PhoneData; update: (d: PhoneData) => void }) {
  const [preview, setPreview] = useState<ImportResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const quotes = quotesOf(snap)

  async function read(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    setError(null); setDone(null); setPreview(null)
    if (!file) return
    try {
      if (file.size > 5_000_000) throw new Error('That file is too big to be an activity report.')
      setPreview(parseRobinhood(await file.text()))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t read that file.')
    }
  }

  function use() {
    if (!preview) return
    const imported = new Set([...preview.trades.map((t) => t.symbol)])
    // Imported tickers take the report's share counts; a ticker you sold out of drops off.
    const shares = { ...Object.fromEntries(Object.entries(data.shares).filter(([s]) => !imported.has(s))), ...preview.shares }
    const holdings = Object.fromEntries(Object.entries(data.holdings).filter(([s]) => !(s in preview.shares)))
    // Drop buy-log entries from earlier imports (the report's trades are the history now).
    const entries = data.entries.filter((x) => x.note !== IMPORT_NOTE)
    // A fresh full report replaces any earlier imported history.
    update({ ...data, shares, holdings, trades: preview.trades, entries, values_as_of: new Date().toISOString() })
    setDone(`✓ Imported ${String(Object.keys(preview.shares).length)} holdings. Check the share counts against your Robinhood app.`)
    setPreview(null)
  }

  return (
    <Card title="Import from Robinhood">
      <p className="text-sm">Fill in your <b>real shares and history</b> from Robinhood’s activity report. The file is read on this phone and never uploaded.</p>
      <label className="btn mt-3 w-full cursor-pointer">Choose the report file
        <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => void read(e)} aria-label="Robinhood activity report file" />
      </label>
      {error && <p role="alert" className="mt-3 text-sm text-[var(--color-down)]">{error}</p>}
      {done && <p role="status" className="mt-3 text-sm text-[var(--color-up)]">{done}</p>}
      {preview && (
        <div className="mt-4 space-y-3">
          <p className="text-sm">Found {String(preview.counts.buys)} buys and {String(preview.counts.sells)} sells from {fmtDay(preview.first_day)} to {fmtDay(preview.last_day)}. You own:</p>
          <ul className="divide-y divide-[var(--line)] text-sm">
            {Object.entries(preview.shares).sort().map(([s, n]) => (
              <li key={s} className="flex items-center gap-3 py-1">
                <span className="w-16 font-mono font-bold">{s}</span>
                <span className="flex-1 font-mono">{fmtShares(n)} shares</span>
                <span className="muted font-mono text-xs">{quotes[s] ? `≈ ${fmtMoney(n * quotes[s].close)}` : 'no daily price'}</span>
              </li>
            ))}
          </ul>
          {preview.warnings.length > 0 && (
            <ul className="stamp space-y-1 p-3 text-xs">{preview.warnings.map((w) => <li key={w}>⚠️ {w}</li>)}</ul>
          )}
          <div className="flex gap-2">
            <button type="button" className="btn flex-1" onClick={use}>Use these</button>
            <button type="button" className="btn btn-ghost" onClick={() => { setPreview(null) }}>Cancel</button>
          </div>
        </div>
      )}
      <Explain title="How do I get the report?">
        <p>In the Robinhood app: <b>Account</b> (person icon) → <b>Menu</b> → <b>Reports and statements</b> → <b>Reports</b> → <b>Generate new report</b>.</p>
        <p>Pick your <b>investing account</b> and a start date <b>from when you opened it</b>, so every buy is included. Robinhood takes about 2 hours (up to a day) to build it, then it shows up in the same place.</p>
        <p>Download it, then tap <b>Choose the report file</b> above and pick it from Files. Do it again whenever you like: a new report replaces the old one.</p>
        <p className="muted text-xs">Crypto and options aren’t included. Robinhood’s report doesn’t list them as shares.</p>
      </Explain>
    </Card>
  )
}

function Invest({ snap, data, update, fresh }: { snap: Snapshot; data: PhoneData; update: (d: PhoneData) => void; fresh: Freshness }) {
  const targets = useTargets(snap, data)
  const quotes = quotesOf(snap)
  const held = valuesOf(snap, data)
  const priced = (s: string) => s in quotes
  const symbols = useMemo(() => [...new Set([...targets.map((t) => t.symbol), ...Object.keys(data.holdings), ...Object.keys(data.shares)])],
    [targets, data.holdings, data.shares])
  const initial = (s: string): string => {
    const v = priced(s) ? data.shares[s] : data.holdings[s]
    return v === undefined ? '' : String(v)
  }
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(symbols.map((s) => [s, initial(s)])))
  const [extra, setExtra] = useState('')
  const [saved, setSaved] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [amount, setAmount] = useState('500')
  const [split, setSplit] = useState<ReturnType<typeof splitContribution> | null>(null)
  const [addToHoldings, setAddToHoldings] = useState(true)
  const [laid, setLaid] = useState(false)

  const rows = drift(targets, held, snap.rules.drift)
  const flagged = rows.filter((r) => r.flagged).length
  const hasValues = Object.keys(held).length > 0

  function saveValues(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault()
    const shares: Record<string, number> = {}
    const dollars: Record<string, number> = {}
    for (const [s, raw] of Object.entries(values)) {
      const txt = raw.replace(/[$,\s]/g, '')
      if (!txt) {
        // An older dollar value for a ticker that now has a price stays until you type shares.
        if (priced(s) && data.holdings[s] !== undefined) dollars[s] = data.holdings[s]
        continue
      }
      const n = Number(txt)
      if (!Number.isFinite(n) || n < 0 || n > 1e9) {
        setProblem(priced(s)
          ? `“${raw}” for ${s} isn’t a number of shares. Type something like 2.5.`
          : `“${raw}” for ${s} isn’t a dollar amount. Type something like 1250.50.`)
        return
      }
      if (n > 0) (priced(s) ? shares : dollars)[s] = n
    }
    setProblem(null)
    // With an imported history, a changed share count is recorded as an adjustment dated today,
    // so the history keeps adding up to what you own.
    const trades = [...data.trades]
    for (const sym of new Set(trades.map((t) => t.symbol))) {
      const diff = Math.round(((shares[sym] ?? 0) - tradedTotal(trades, sym)) * 1e6) / 1e6
      if (Math.abs(diff) > 1e-6 && priced(sym)) trades.push({ day: localDay(), symbol: sym, qty: diff, source: 'adjust' })
    }
    update({ ...data, shares, trades, holdings: dollars, values_as_of: new Date().toISOString() })
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
    if (fresh.stale) {
      setProblem('Prices are out of date, so the split is paused until the next update. ' + fresh.reason)
      return
    }
    setProblem(null)
    setLaid(false)
    setSplit(splitContribution(n, targets, held, skipFor(targets)))
  }

  function logBuy() {
    if (!split) return
    const next = recordBuy(data, split.allocations, quotes, addToHoldings)
    update(next)
    const { holdings, shares } = next
    if (addToHoldings) {
      const updated = { ...values }
      for (const [k, v] of Object.entries(holdings)) if (!priced(k)) updated[k] = String(v)
      for (const [k, v] of Object.entries(shares)) if (priced(k)) updated[k] = String(v)
      setValues(updated)
    }
    setLaid(true)
  }

  return (
    <div className="space-y-5">
      <PageHeader title="Invest" intro="Three steps, about two minutes. Keep your broker app open alongside." />
      <Stamp snap={snap} />

      <RobinhoodImport snap={snap} data={data} update={(d) => {
        update(d)
        setValues(Object.fromEntries([...new Set([...symbols, ...Object.keys(d.shares)])].map((s) => [s, (priced(s) ? d.shares[s] : d.holdings[s])?.toString() ?? ''])))
      }} />

      <Card title="1 · What you own">
        <p className="muted mb-3 text-sm">
          Open your broker app and copy how many <b>shares</b> you own of each one (fractions are fine, like 0.4521). Leave blank what you don’t own.
          {data.values_as_of && ` Last updated ${fmtTimestamp(data.values_as_of)}.`}
        </p>
        <form onSubmit={saveValues} className="space-y-2">
          {symbols.concat(Object.keys(values).filter((s) => !symbols.includes(s))).map((s) => {
            const t = targets.find((x) => x.symbol === s)
            const q = quotes[s]
            const n = Number((values[s] ?? '').replace(/[,\s]/g, ''))
            return (
              <label key={s} className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                <span className="w-16 font-mono font-bold">{s}</span>
                <span className="muted hidden flex-1 truncate text-xs sm:inline">{t ? t.name : 'not in your plan'}</span>
                {q ? (
                  <>
                    <input className="input ml-auto w-28 sm:ml-0" inputMode="decimal" placeholder="0" value={values[s] ?? ''} aria-label={`${s} shares`}
                      onChange={(e) => { setSaved(false); setValues({ ...values, [s]: e.target.value }) }} />
                    <span className="muted w-24 text-right font-mono text-xs">{n > 0 ? `≈ ${fmtMoney(n * q.close)}` : 'shares'}</span>
                  </>
                ) : (
                  <>
                    <span className="ml-auto font-mono sm:ml-0">$</span>
                    <input className="input w-28" inputMode="decimal" placeholder="0" value={values[s] ?? ''} aria-label={`${s} value in dollars`}
                      onChange={(e) => { setSaved(false); setValues({ ...values, [s]: e.target.value }) }} />
                    <span className="muted w-24 text-right text-xs">no price: type $</span>
                  </>
                )}
                {q && !values[s] && data.holdings[s] !== undefined && (
                  <span className="muted w-full pl-[4.75rem] text-xs">Using the {fmtMoney(data.holdings[s])} you typed before. Type shares to get the chart.</span>
                )}
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
        <Explain title="Why type shares?">
          <p>Shares are the one number that doesn’t change by itself. The app multiplies them by each evening’s closing price, so your total and your chart stay current without retyping.</p>
          <p>Your shares never leave this phone. For a ticker with no daily price, type its dollar value instead.</p>
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

      <Card title="3 · Log what you bought">
        {!split ? (
          <p className="muted text-sm">Split your money above, buy it in your broker app, then come back here.</p>
        ) : laid ? (
          <p className="font-semibold text-[var(--color-up)]">✓ Logged. Today’s move will show you’re done until your next buy day.</p>
        ) : (
          <>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={addToHoldings} onChange={(e) => { setAddToHoldings(e.target.checked) }} />
              Also add these to what I own (shares estimated at the last close; fix them from your broker app later)
            </label>
            <button className="btn mt-3 w-full" onClick={logBuy}>
              I invested {fmtMoney(split.allocations.reduce((a, x) => a + x.amount, 0))}
            </button>
          </>
        )}
      </Card>
      <BackupCard data={data} update={update} />
      {problem && <p role="alert" className="fixed inset-x-4 bottom-24 z-20 border-l-4 border-[var(--color-down)] bg-[var(--panel)] p-3 text-sm shadow-xl">{problem}</p>}
    </div>
  )
}

function PlanPage({ snap, data, update }: { snap: Snapshot; data: PhoneData; update: (d: PhoneData) => void }) {
  const total = Object.values(valuesOf(snap, data)).reduce((a, v) => a + v, 0)
  const basis = total > 0 ? total : 10_000
  const targets = useTargets(snap, data)
  const plan: PlanData = {
    targets: targets.map((t) => ({ ...t, target_value: Math.round((t.target_pct / 100) * basis * 100) / 100 })),
    screen: snap.plan.screen,
    fundamentals: { source: snap.plan.source, fetched_at: snap.plan.fetched_at, stale: snap.plan.stale, reason: snap.plan.reason, last_error: snap.plan.last_error },
    basis_value: basis,
    basis_is_reference: total <= 0,
  }
  return (
    <div>
      <PageHeader title="My Plan" intro="What to own and why. Updated from companies’ official reports." />
      <Stamp snap={snap} />
      <div className="mb-5 space-y-5">
        <SplitSetting snap={snap} data={data} update={update} />
        <CompanyStatus snap={snap} targets={targets} />
        <OverlapCard snap={snap} targets={targets} />
      </div>
      <PlanView data={plan} />
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Shell

const TABS = [
  { id: 'today', label: 'Today', icon: 'M3 20h18M5 20v-6a7 7 0 0 1 14 0v6M10 7l2-3 2 3' },
  { id: 'invest', label: 'Invest', icon: 'M12 3v18M7 8h7a3 3 0 0 1 0 6H9a3 3 0 0 0 0 6h8' },
  { id: 'search', label: 'Search', icon: 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM20 20l-4.8-4.8' },
  { id: 'plan', label: 'Plan', icon: 'M3 20h18M4 20v-5h7v5M13 20v-9h7v9M8 15V9h8v2' },
  { id: 'learn', label: 'Learn', icon: 'M4 5h7a3 3 0 0 1 3 3v12a2 2 0 0 0-2-2H4zM20 5h-6a3 3 0 0 0-3 3' },
] as const
type TabId = (typeof TABS)[number]['id']
const ALIAS: Record<string, TabId> = { home: 'today', money: 'invest', wall: 'invest' }

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
  const [status, setStatus] = useState<RefreshStatus | null>(null)
  const [now] = useState(() => new Date())
  const [research, setResearch] = useState<Research | null>(null)
  const [researchError, setResearchError] = useState<string | null>(null)

  useEffect(() => { applyTheme(theme) }, [theme])
  useEffect(() => {
    const on = () => { setTab(tabFromHash()); window.scrollTo(0, 0) }
    window.addEventListener('hashchange', on)
    return () => { window.removeEventListener('hashchange', on) }
  }, [])
  useEffect(() => {
    fetchSnapshot().then(setSnap, (e: unknown) => { setError(e instanceof Error ? e.message : 'Couldn’t load today’s data.') })
    fetchStatus().then(setStatus, () => { setStatus(null) })
    fetchResearch().then(setResearch, (e: unknown) => { setResearchError(e instanceof Error ? e.message : 'Search data isn’t available.') })
    void askPersistent()
  }, [])

  // Live prices (only with your own key): what you own first, then your watchlist, then the plan.
  const liveSymbols = useMemo(() => [
    ...Object.keys(data.shares).filter((k) => (data.shares[k] ?? 0) > 0),
    ...data.watchlist.map((w) => w.symbol),
    ...(snap?.plan.targets.map((t) => t.symbol) ?? []),
  ], [data.shares, data.watchlist, snap])

  const update = useCallback((d: PhoneData) => {
    setData(d)
    if (!save(d)) setError('Couldn’t save on this phone (storage full or private mode). Save a backup.')
  }, [])

  return (
    <div className="flex min-h-screen flex-col" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
      <header className="mx-auto flex w-full max-w-2xl items-center justify-between px-4 pt-4">
        <div className="flex items-center gap-2">
          <KeystoneLogo size={30} />
          <span className="wordmark text-lg">Keystone Ledger</span>
        </div>
        <button className="btn btn-ghost px-2 py-1 text-xs" aria-label="Toggle theme" onClick={() => { setTheme(theme === 'dark' ? 'light' : 'dark') }}>
          {theme === 'dark' ? '☀ Prism' : '✦ Aurora'}
        </button>
      </header>
      <LiveProvider symbols={liveSymbols}>
      <ResearchCtx.Provider value={research}>
      <main className="mx-auto w-full max-w-2xl flex-1 px-4 pb-32 pt-6">
        {error && <p role="alert" className="mb-4 border-l-4 border-[var(--color-down)] p-3 text-sm">{error}</p>}
        {!snap && !error && <p className="muted">Loading today’s data…</p>}
        {snap && tab === 'today' && <Today snap={snap} data={data} theme={theme} update={update} fresh={freshnessOf(snap, status, now)} now={now} />}
        {snap && tab === 'invest' && <Invest snap={snap} data={data} update={update} fresh={freshnessOf(snap, status, now)} />}
        {tab === 'search' && (
          <SearchPage research={research} error={researchError} watch={phoneWatch(data, update)}
            chart={(sym) => (snap && historyOf(snap).closes[sym]
              ? <RangeChart series={tickerSeries(sym, historyOf(snap))} theme={theme} eyebrow={`${sym} price`} label={`Line chart of ${sym}'s closing price`} />
              : null)} />
        )}
        {snap && tab === 'plan' && <PlanPage snap={snap} data={data} update={update} />}
        {snap && tab === 'learn' && (
          <div><PageHeader title="Learn" intro="Every word the app uses, in plain English." /><LearnView data={snap.learn} /></div>
        )}
        <p className="muted mt-10 text-center text-xs">
          Educational tool, not financial advice. Your holdings and watchlist stay on this device. {snap && `Data updated ${fmtTimestamp(snap.generated_at)}.`}
          <br />App version {fmtTimestamp(__APP_BUILT__)}
        </p>
      </main>
      </ResearchCtx.Provider>
      </LiveProvider>
      <nav aria-label="Main" className="fixed inset-x-3 bottom-3 z-10"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
        <div className="dock mx-auto flex max-w-xl px-1">
          {TABS.map((t) => (
            <a key={t.id} href={`#/${t.id}`} aria-current={tab === t.id ? 'page' : undefined}
              className={`flex flex-1 flex-col items-center gap-0.5 py-2.5 text-[0.68rem] font-semibold tracking-wide ${tab === t.id ? '' : 'muted'}`}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={t.icon} /></svg>
              {t.label}
            </a>
          ))}
        </div>
      </nav>
    </div>
  )
}

// Today's "Right now" card: what your shares are worth at this minute, and the line since you
// opened the app. Live prices are for looking only; buy amounts always use the last close.
import { Card, Explain } from '../components/ui'
import { fmtMoney, fmtSignedMoney, fmtSignedPct, fmtTimestamp, gainClass } from '../format'
import { liveValueSeries } from './live'
import { useLive } from './LiveContext'
import type { Quote } from './portfolio'

function Spark({ values, up }: { values: number[]; up: boolean }) {
  if (values.length < 2) return null
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const span = hi - lo || 1
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * 300).toFixed(1)},${(56 - ((v - lo) / span) * 52).toFixed(1)}`).join(' ')
  return (
    <svg viewBox="0 0 300 60" className="mt-3 h-16 w-full" role="img" aria-label="Line of your money's value since you opened the app">
      <polyline points={pts} fill="none" strokeWidth="2.5" strokeLinejoin="round" stroke={up ? 'var(--color-up)' : 'var(--color-down)'} />
    </svg>
  )
}

export function LiveNow({ shares, quotes }: { shares: Record<string, number>; quotes: Record<string, Quote> }) {
  const live = useLive()
  if (!live.key) return null
  const held = Object.entries(shares).filter(([, n]) => n > 0)
  if (held.length === 0) {
    return (
      <Card>
        <div className="eyebrow">Right now <span className="text-[var(--color-up)]">● Live</span></div>
        <p className="mt-2 text-sm">Live prices are on. Add the shares you own on the Invest tab to see what they’re worth this minute.</p>
      </Card>
    )
  }
  let now = 0
  let close = 0
  const liveSyms: string[] = []
  for (const [sym, n] of held) {
    const q = quotes[sym]
    const lq = live.quotes[sym]
    const last = lq?.price ?? q?.close
    const prev = lq?.prev_close ?? q?.close
    if (last === undefined || prev === undefined) continue
    now += n * last
    close += n * prev
    if (lq) liveSyms.push(sym)
  }
  const change = close > 0 ? now - close : null
  const pct = close > 0 && change !== null ? (change / close) * 100 : null
  const closes = Object.fromEntries(Object.entries(quotes).map(([s, q]) => [s, q.close]))
  const series = liveValueSeries(shares, closes, live.rounds).map((p) => p.value)
  const up = (change ?? 0) >= 0
  return (
    <Card>
      <div className="eyebrow">Right now <span className="text-[var(--color-up)]">● Live</span></div>
      <div className="serif text-5xl font-bold tabular-nums" aria-live="polite">{fmtMoney(Math.round(now * 100) / 100)}</div>
      <div className={`mt-1 font-mono text-sm ${gainClass(change)}`}>
        <span aria-hidden>{up ? '▲ ' : '▼ '}</span>{fmtSignedMoney(change === null ? null : Math.round(change * 100) / 100)} ({fmtSignedPct(pct)})
        <span className="muted ml-2 font-sans">today</span>
      </div>
      <div className="muted text-xs">
        {live.error ? <span className="text-[var(--color-down)]">{live.error}</span>
          : live.checkedAt ? `Live prices for ${String(liveSyms.length)} of ${String(held.length)} holdings · ${fmtTimestamp(live.checkedAt)}`
            : 'Getting live prices…'}
      </div>
      <Spark values={series} up={up} />
      {series.length > 0 && series.length < 2 && <p className="muted mt-2 text-xs">The line for today starts drawing from the next minute.</p>}
      <Explain title="What is this?">
        <p>What the shares you own are worth <b>this minute</b>, from live prices, and how much that is up or down since yesterday’s close. Holdings without a live price use their last close.</p>
        <p>The line starts when you open the app and adds a point each minute while it stays open. It isn’t saved anywhere.</p>
        <p><b>For looking only.</b> Your buy days and amounts always use the last close, so a price that wiggles during the day never changes your plan.</p>
      </Explain>
    </Card>
  )
}

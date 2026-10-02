import { useEffect, useState } from 'react'
import { api, type Chart } from '../api'
import { EVENT_COLOR, PriceChart } from '../components/PriceChart'
import { Card, ErrorText, Explain, PageHeader, SourceLine, StaleBanner } from '../components/ui'
import { fmtDay, fmtMoney } from '../format'
import { errorMessage, useApi } from '../useApi'

interface Option {
  symbol: string
  label: string
}

async function loadOptions(): Promise<Option[]> {
  const [plan, holdings] = await Promise.all([api.plan(), api.holdings()])
  const opts: Option[] = [{ symbol: '^GSPC', label: 'S&P 500 (the whole US market)' }]
  for (const t of plan.targets) opts.push({ symbol: t.symbol, label: `${t.symbol} · ${t.name}` })
  for (const p of holdings.portfolio.positions) {
    if (!opts.some((o) => o.symbol === p.symbol)) opts.push({ symbol: p.symbol, label: `${p.symbol} · you own this` })
  }
  for (const r of plan.screen) {
    if (!opts.some((o) => o.symbol === r.symbol)) opts.push({ symbol: r.symbol, label: `${r.symbol} · ${r.company}` })
  }
  return opts
}

export function Charts({ theme }: { theme: string }) {
  const options = useApi(loadOptions)
  const [symbol, setSymbol] = useState('VTI')
  const [result, setResult] = useState<{ symbol: string; chart: Chart | null; error: string | null } | null>(null)
  const [selected, setSelected] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api.chart(symbol).then(
      (c) => {
        if (!cancelled) setResult({ symbol, chart: c, error: null })
      },
      (err: unknown) => {
        if (!cancelled) setResult({ symbol, chart: null, error: errorMessage(err) })
      },
    )
    return () => {
      cancelled = true
    }
  }, [symbol])

  const loading = result?.symbol !== symbol
  const chart = result?.chart ?? null
  const error = result?.error ?? null
  const events = chart ? [...chart.events].reverse() : []

  return (
    <div>
      <PageHeader
        title="Charts"
        intro="See how a price has moved over the last 2 years. Colored circles mark moments worth noticing; hover over one (or tap it in the list) for a plain explanation."
        action={
          <label className="text-sm">
            Show me
            <select className="input mt-1 min-w-64" value={symbol} onChange={(e) => { setSymbol(e.target.value); setSelected(null) }}>
              {(options.data ?? [{ symbol: 'VTI', label: 'VTI' }]).map((o) => (
                <option key={o.symbol} value={o.symbol}>{o.label}</option>
              ))}
            </select>
          </label>
        }
      />
      {error && <ErrorText>{error}</ErrorText>}
      {chart && (
        <div className="space-y-6">
          <StaleBanner items={[{ label: chart.symbol, f: chart.freshness }]} />
          <Card>
            {loading && <p className="muted mb-2 text-sm">Loading…</p>}
            {chart.points.length === 0 ? (
              <p>No price history yet for {chart.symbol}. Go to Home and click “Refresh prices”.</p>
            ) : (
              <PriceChart points={chart.points} events={chart.events} theme={theme} selected={selected} />
            )}
            <SourceLine f={chart.freshness} />
            <Explain title="How do I read this chart?">
              <p>
                The <b>blue line</b> is the price at the end of each trading day. The two other lines are{' '}
                <b>moving averages</b>: the average price over the last 50 days (orange, the short-term trend) and the last
                200 days (pink, the long-term trend). They smooth out daily noise so you can see the direction.
              </p>
              <p>The colored circles mark moments worth noticing:</p>
              <ul className="list-disc space-y-1 pl-5">
                <li><b style={{ color: EVENT_COLOR.golden_cross }}>Golden cross</b>: the short-term line crossed <b>above</b> the long-term line. Recent momentum turned stronger. Usually seen as a good sign, but it shows up late.</li>
                <li><b style={{ color: EVENT_COLOR.death_cross }}>Death cross</b>: the short-term line crossed <b>below</b> the long-term line. Momentum weakened. Scary name, but it’s often late too, and many stocks recover soon after. Information, not an alarm.</li>
                <li><b style={{ color: EVENT_COLOR.big_up }}>Big jump</b> / <b style={{ color: EVENT_COLOR.big_down }}>Big drop</b>: a day the price moved much more than usual for this stock (at least 3 times its normal daily move, and at least 3%). Something usually happened, like a profit report or news.</li>
              </ul>
              <p>None of these tell you what happens next. For a long-term plan they’re context, not instructions.</p>
            </Explain>
          </Card>
          <Card title={`Moments on this chart (${String(events.length)})`}>
            {events.length === 0 ? (
              <p className="muted">Nothing notable in this period: no crossovers and no unusually big days.</p>
            ) : (
              <ul className="space-y-2">
                {events.map((e) => (
                  <li key={`${e.day}-${e.kind}`}>
                    <button
                      className={`w-full rounded-lg border p-3 text-left text-sm ${selected === e.day ? 'border-[var(--color-brand)]' : 'border-[var(--line)]'}`}
                      onClick={() => { setSelected(e.day) }}
                    >
                      <div className="flex flex-wrap justify-between gap-2">
                        <b style={{ color: EVENT_COLOR[e.kind] }}>● {e.label}</b>
                        <span className="muted">{fmtDay(e.day)} · price {fmtMoney(e.price)}</span>
                      </div>
                      <p className="mt-1 leading-relaxed">{e.explanation}</p>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
    </div>
  )
}

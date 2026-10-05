import {
  type IChartApi,
  type MouseEventParams,
  type SeriesMarker,
  type Time,
  CrosshairMode,
  createChart,
  createSeriesMarkers,
  LineSeries,
  LineStyle,
} from 'lightweight-charts'
import { useEffect, useRef, useState } from 'react'
import type { ChartEvent, ChartPoint, EventKind } from '../api'
import { fmtDay, fmtMoney } from '../format'

/** CSS custom properties per role; values are validated per theme in index.css. */
export const EVENT_COLOR: Record<EventKind, string> = {
  golden_cross: 'var(--ev-golden)',
  death_cross: 'var(--ev-death)',
  big_up: 'var(--ev-up)',
  big_down: 'var(--ev-down)',
}
const EVENT_VAR: Record<EventKind, string> = {
  golden_cross: '--ev-golden',
  death_cross: '--ev-death',
  big_up: '--ev-up',
  big_down: '--ev-down',
}
const LINE = { price: 'var(--chart-price)', sma50: 'var(--chart-sma50)', sma200: 'var(--chart-sma200)' }

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

interface Hover {
  day: string
  close: number | null
  sma50: number | null
  sma200: number | null
  event: ChartEvent | null
}

export function PriceChart({
  points,
  events,
  theme,
  selected,
}: {
  points: ChartPoint[]
  events: ChartEvent[]
  theme: string
  selected: string | null
}) {
  const el = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const [hover, setHover] = useState<Hover | null>(null)

  useEffect(() => {
    const host = el.current
    if (!host || points.length === 0) return
    // The canvas needs concrete colors: read the active theme's validated values.
    const text = cssVar('--muted', '#5c584c')
    const grid = cssVar('--rule', 'rgba(0,0,0,0.08)')
    const line = cssVar('--line', '#cdbf9d')
    const color = {
      price: cssVar('--chart-price', '#2a62b8'),
      sma50: cssVar('--chart-sma50', '#d4612a'),
      sma200: cssVar('--chart-sma200', '#178f68'),
    }
    const chart = createChart(host, {
      autoSize: true,
      layout: {
        background: { color: 'transparent' },
        textColor: text,
        fontFamily: '"JetBrains Mono Variable", ui-monospace, monospace',
        attributionLogo: true,
      },
      grid: { vertLines: { color: grid }, horzLines: { color: grid } },
      rightPriceScale: { borderColor: line },
      timeScale: { borderColor: line },
      crosshair: { mode: CrosshairMode.Normal },
      // Pin the locale: some browsers report tags like "en-US@posix" that Intl rejects, which
      // silently stops the chart from drawing.
      localization: { locale: 'en-US' },
    })
    chartRef.current = chart
    const price = chart.addSeries(LineSeries, { color: color.price, lineWidth: 2, title: 'Price' })
    const s50 = chart.addSeries(LineSeries, { color: color.sma50, lineWidth: 2, lineStyle: LineStyle.Dashed, title: '50-day', priceLineVisible: false, lastValueVisible: false })
    const s200 = chart.addSeries(LineSeries, { color: color.sma200, lineWidth: 2, title: '200-day', priceLineVisible: false, lastValueVisible: false })
    price.setData(points.map((p) => ({ time: p.day, value: p.close })))
    s50.setData(points.flatMap((p) => (p.sma50 === null ? [] : [{ time: p.day, value: p.sma50 }])))
    s200.setData(points.flatMap((p) => (p.sma200 === null ? [] : [{ time: p.day, value: p.sma200 }])))

    const markers: SeriesMarker<Time>[] = events.map((e) => ({
      time: e.day,
      position: e.kind === 'big_down' || e.kind === 'death_cross' ? 'belowBar' : 'aboveBar',
      // Shape is a second cue beside color: arrows for big days, circles for crossovers.
      shape: e.kind === 'big_up' ? 'arrowUp' : e.kind === 'big_down' ? 'arrowDown' : 'circle',
      color: cssVar(EVENT_VAR[e.kind], '#888888'),
      size: 2,
      text: e.label,
    }))
    createSeriesMarkers(price, markers)
    chart.timeScale().fitContent()

    const byDay = new Map(points.map((p) => [p.day, p]))
    const eventByDay = new Map(events.map((e) => [e.day, e]))
    const onMove = (param: MouseEventParams) => {
      if (param.time === undefined || typeof param.time !== 'string') {
        setHover(null)
        return
      }
      const p = byDay.get(param.time)
      setHover({
        day: param.time,
        close: p?.close ?? null,
        sma50: p?.sma50 ?? null,
        sma200: p?.sma200 ?? null,
        event: eventByDay.get(param.time) ?? null,
      })
    }
    chart.subscribeCrosshairMove(onMove)
    return () => {
      chart.unsubscribeCrosshairMove(onMove)
      chart.remove()
      chartRef.current = null
    }
  }, [points, events, theme])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart || !selected) return
    const idx = points.findIndex((p) => p.day === selected)
    if (idx < 0) return
    chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, idx - 60), to: Math.min(points.length - 1, idx + 60) })
  }, [selected, points])

  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-4 text-xs">
        <span><span style={{ color: LINE.price }}>━━</span> Price (closing price each day)</span>
        <span><span style={{ color: LINE.sma50 }}>╍╍</span> 50-day average (short-term trend, ~2½ months)</span>
        <span><span style={{ color: LINE.sma200 }}>━━</span> 200-day average (long-term trend, ~10 months)</span>
      </div>
      <div className="relative">
        <div ref={el} className="h-[420px] w-full" data-testid="price-chart" />
        {hover && (
          <div className="pointer-events-none absolute left-2 top-2 z-10 max-w-sm border-2 border-[var(--line)] bg-[var(--panel)] p-3 text-xs shadow-[4px_4px_0_0_var(--line)]">
            <div className="font-semibold">{fmtDay(hover.day)}</div>
            <div>Price: {fmtMoney(hover.close)}</div>
            <div>50-day average: {fmtMoney(hover.sma50)}</div>
            <div>200-day average: {hover.sma200 === null ? 'not enough history yet' : fmtMoney(hover.sma200)}</div>
            {hover.event && (
              <div className="mt-2 border-t border-[var(--line)] pt-2">
                <div className="font-bold">
                  <span aria-hidden style={{ color: EVENT_COLOR[hover.event.kind] }}>{hover.event.kind === 'big_up' ? '▲' : hover.event.kind === 'big_down' ? '▼' : '●'}</span>{' '}
                  {hover.event.label}
                </div>
                <p className="mt-1 leading-relaxed">{hover.event.explanation}</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

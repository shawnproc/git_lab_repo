import {
  type IChartApi,
  type MouseEventParams,
  type SeriesMarker,
  type Time,
  CrosshairMode,
  createChart,
  createSeriesMarkers,
  LineSeries,
} from 'lightweight-charts'
import { useEffect, useRef, useState } from 'react'
import type { ChartEvent, ChartPoint, EventKind } from '../api'
import { fmtDay, fmtMoney } from '../format'

export const EVENT_COLOR: Record<EventKind, string> = {
  golden_cross: '#fbbf24',
  death_cross: '#a78bfa',
  big_up: '#34d399',
  big_down: '#fb7185',
}

const LINE = { price: '#22d3ee', sma50: '#f59e0b', sma200: '#e879f9' }

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
    const text = cssVar('--muted', '#8b95ad')
    const line = cssVar('--line', '#222c45')
    const chart = createChart(host, {
      autoSize: true,
      layout: { background: { color: 'transparent' }, textColor: text, attributionLogo: true },
      grid: { vertLines: { color: line }, horzLines: { color: line } },
      rightPriceScale: { borderColor: line },
      timeScale: { borderColor: line },
      crosshair: { mode: CrosshairMode.Normal },
      // Pin the locale: some browsers report tags like "en-US@posix" that Intl rejects, which
      // silently stops the chart from drawing.
      localization: { locale: 'en-US' },
    })
    chartRef.current = chart
    const price = chart.addSeries(LineSeries, { color: LINE.price, lineWidth: 2, title: 'Price' })
    const s50 = chart.addSeries(LineSeries, { color: LINE.sma50, lineWidth: 2, title: '50-day', priceLineVisible: false, lastValueVisible: false })
    const s200 = chart.addSeries(LineSeries, { color: LINE.sma200, lineWidth: 2, title: '200-day', priceLineVisible: false, lastValueVisible: false })
    price.setData(points.map((p) => ({ time: p.day, value: p.close })))
    s50.setData(points.flatMap((p) => (p.sma50 === null ? [] : [{ time: p.day, value: p.sma50 }])))
    s200.setData(points.flatMap((p) => (p.sma200 === null ? [] : [{ time: p.day, value: p.sma200 }])))

    const markers: SeriesMarker<Time>[] = events.map((e) => ({
      time: e.day,
      position: e.kind === 'big_down' || e.kind === 'death_cross' ? 'belowBar' : 'aboveBar',
      shape: 'circle',
      color: EVENT_COLOR[e.kind],
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
        <span><span style={{ color: LINE.price }}>━</span> Price (closing price each day)</span>
        <span><span style={{ color: LINE.sma50 }}>━</span> 50-day average (short-term trend, ~2½ months)</span>
        <span><span style={{ color: LINE.sma200 }}>━</span> 200-day average (long-term trend, ~10 months)</span>
      </div>
      <div className="relative">
        <div ref={el} className="h-[420px] w-full" data-testid="price-chart" />
        {hover && (
          <div className="pointer-events-none absolute left-2 top-2 z-10 max-w-sm rounded-lg border border-[var(--line)] bg-[var(--panel)] p-3 text-xs shadow-xl">
            <div className="font-semibold">{fmtDay(hover.day)}</div>
            <div>Price: {fmtMoney(hover.close)}</div>
            <div>50-day average: {fmtMoney(hover.sma50)}</div>
            <div>200-day average: {hover.sma200 === null ? 'not enough history yet' : fmtMoney(hover.sma200)}</div>
            {hover.event && (
              <div className="mt-2 border-t border-[var(--line)] pt-2">
                <div className="font-bold" style={{ color: EVENT_COLOR[hover.event.kind] }}>● {hover.event.label}</div>
                <p className="mt-1 leading-relaxed">{hover.event.explanation}</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

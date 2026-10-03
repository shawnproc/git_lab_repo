import {
  type MouseEventParams,
  CrosshairMode,
  createChart,
  LineSeries,
  LineStyle,
  TrackingModeExitMode,
} from 'lightweight-charts'
import { useEffect, useRef } from 'react'
import type { Point } from '../phone/portfolio'

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

/** A clean value line: no grid or axes, a dotted line at the starting value, and a finger
 * (or mouse) scrub that reports the point under it. Color follows up/down; the caller also shows
 * ▲/▼ so color is never the only cue. */
export function ValueChart({
  points,
  base,
  up,
  theme,
  onHover,
  label,
}: {
  points: Point[]
  base: number | null
  up: boolean
  theme: string
  onHover: (p: Point | null) => void
  label: string
}) {
  const el = useRef<HTMLDivElement>(null)
  const hover = useRef(onHover)
  useEffect(() => { hover.current = onHover }, [onHover])

  useEffect(() => {
    const host = el.current
    if (!host || points.length === 0) return
    const color = up ? cssVar('--color-up', '#1f7a45') : cssVar('--color-down', '#b3261e')
    const muted = cssVar('--muted', '#5c584c')
    const chart = createChart(host, {
      autoSize: true,
      layout: { background: { color: 'transparent' }, textColor: muted, attributionLogo: true },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      rightPriceScale: { visible: false },
      leftPriceScale: { visible: false },
      timeScale: { visible: false, borderVisible: false, fixLeftEdge: true, fixRightEdge: true },
      crosshair: {
        mode: CrosshairMode.Magnet,
        horzLine: { visible: false, labelVisible: false },
        vertLine: { color: muted, style: LineStyle.Solid, width: 1, labelVisible: false },
      },
      handleScroll: false,
      handleScale: false,
      trackingMode: { exitMode: TrackingModeExitMode.OnTouchEnd },
      localization: { locale: 'en-US' },
    })
    const line = chart.addSeries(LineSeries, {
      color,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerRadius: 5,
    })
    line.setData(points.map((p) => ({ time: p.day, value: p.value })))
    if (base !== null) {
      line.createPriceLine({ price: base, color: muted, lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: false, title: '' })
    }
    chart.timeScale().fitContent()
    const byDay = new Map(points.map((p) => [p.day, p]))
    const onMove = (param: MouseEventParams) => {
      const p = typeof param.time === 'string' ? byDay.get(param.time) : undefined
      hover.current(p ?? null)
    }
    chart.subscribeCrosshairMove(onMove)
    return () => {
      chart.unsubscribeCrosshairMove(onMove)
      chart.remove()
    }
  }, [points, base, up, theme])

  // The small TradingView logo stays on: Lightweight Charts' license asks for that attribution.
  return <div ref={el} role="img" aria-label={label} className="h-56 w-full touch-none select-none" data-testid="value-chart" />
}

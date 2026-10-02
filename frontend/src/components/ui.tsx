import type { ReactNode } from 'react'
import type { Freshness } from '../api'
import { fmtDay, fmtTimestamp } from '../format'

export function Card({ title, children, className = '' }: { title?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`panel p-5 ${className}`}>
      {title && <h3 className="mb-3 text-lg font-bold">{title}</h3>}
      {children}
    </section>
  )
}

/** A beginner-friendly "What does this mean?" box. Closed by default, one click to open. */
export function Explain({ title = 'What does this mean?', children }: { title?: string; children: ReactNode }) {
  return (
    <details className="explain mt-3 rounded-xl border border-[var(--line)] bg-[var(--panel-2)] px-4 py-2 text-sm">
      <summary className="cursor-pointer select-none font-semibold text-[var(--color-brand)]">💡 {title}</summary>
      <div className="mt-2 space-y-2 leading-relaxed">{children}</div>
    </details>
  )
}

export function PageHeader({ title, intro, action }: { title: string; intro: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="max-w-3xl">
        <h2 className="text-2xl font-bold">{title}</h2>
        <p className="muted mt-1">{intro}</p>
      </div>
      {action}
    </div>
  )
}

export function ErrorText({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="rounded-lg border border-[var(--color-down)] p-3 text-[var(--color-down)]">
      {children}
    </p>
  )
}

/** Loud warning whenever any number on the page is old or missing. */
export function StaleBanner({ items }: { items: { label: string; f: Freshness }[] }) {
  const stale = items.filter((i) => i.f.stale)
  if (stale.length === 0) return null
  return (
    <div
      role="alert"
      className="mb-6 rounded-xl border-2 border-[var(--color-warn)] bg-[color-mix(in_oklab,var(--color-warn)_14%,transparent)] p-4"
    >
      <div className="font-bold text-[var(--color-warn)]">⚠️ Some numbers are old or missing. Don’t act on them yet.</div>
      <p className="mt-1 text-sm">
        Click <b>Refresh prices</b>. If this stays, the free data source may be down or limiting requests; try again later.
      </p>
      <ul className="mt-2 space-y-1 text-sm">
        {stale.map((i) => (
          <li key={i.label}>
            <span className="font-semibold">{i.label}:</span> {i.f.reason}
            {i.f.last_error && <span className="muted"> (last try: {i.f.last_error})</span>}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Small "where did this number come from" line. */
export function SourceLine({ f }: { f: Freshness }) {
  return (
    <p className="muted mt-2 text-xs">
      Price from {f.last_day ? fmtDay(f.last_day) : '—'} · source: {f.source ?? 'none yet'} · fetched {fmtTimestamp(f.fetched_at)}
    </p>
  )
}

export function StatusIcon({ status }: { status: 'pass' | 'fail' | 'unavailable' }) {
  const map = {
    pass: { icon: '✅', label: 'Passed' },
    fail: { icon: '❌', label: 'Failed' },
    unavailable: { icon: '➖', label: 'No data' },
  } as const
  const m = map[status]
  return (
    <span role="img" aria-label={m.label} title={m.label}>
      {m.icon}
    </span>
  )
}

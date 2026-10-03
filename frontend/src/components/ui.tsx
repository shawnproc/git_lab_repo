import type { ReactNode } from 'react'
import type { Freshness } from '../api'
import { fmtDay, fmtTimestamp } from '../format'
import { StoneIcon } from './brand'

export function Card({ title, children, className = '' }: { title?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`panel p-5 sm:p-6 ${className}`}>
      {title && <h3 className="card-title mb-4">{title}</h3>}
      {children}
    </section>
  )
}

/** A margin note: "What does this mean?" in plain words. Closed by default, one click to open. */
export function Explain({ title = 'What does this mean?', children }: { title?: string; children: ReactNode }) {
  return (
    <details className="explain mt-4 px-4 py-2 text-sm">
      <summary className="cursor-pointer select-none font-semibold text-[var(--color-brand-2)]">Margin note: {title}</summary>
      <div className="mt-2 space-y-2 leading-relaxed">{children}</div>
    </details>
  )
}

/** Page heading styled like a ledger folio: a small page number above a serif title. */
export function PageHeader({ folio, title, intro, action }: { folio?: string; title: string; intro: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4 border-b-2 border-[var(--line)] pb-5">
      <div className="max-w-3xl">
        {folio && <div className="eyebrow mb-1">Folio {folio}</div>}
        <h2 className="text-4xl font-semibold sm:text-5xl">{title}</h2>
        <p className="muted mt-2 text-base">{intro}</p>
      </div>
      {action}
    </div>
  )
}

export function ErrorText({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="border-l-4 border-[var(--color-down)] bg-[color-mix(in_oklab,var(--color-down)_10%,transparent)] p-3 text-[var(--color-down)]">
      {children}
    </p>
  )
}

/** Inked stamp whenever any number on the page is old or missing. */
export function StaleBanner({ items }: { items: { label: string; f: Freshness }[] }) {
  const stale = items.filter((i) => i.f.stale)
  if (stale.length === 0) return null
  return (
    <div role="alert" className="stamp mb-8 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="stamp-label">Stale data</span>
        <span className="font-bold">Some numbers are old or missing. Don’t act on them yet.</span>
      </div>
      <p className="mt-2 text-sm">
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
    <p className="muted mt-3 font-mono text-[0.7rem]">
      PRICE FROM {f.last_day ? fmtDay(f.last_day).toUpperCase() : '—'} · SOURCE {f.source ?? 'NONE YET'} · FETCHED {fmtTimestamp(f.fetched_at).toUpperCase()}
    </p>
  )
}

export function StatusIcon({ status }: { status: 'pass' | 'fail' | 'unavailable' }) {
  return <StoneIcon status={status} />
}

/** A labelled figure: small caps label, big mono number, optional sub-line. */
export function Figure({ label, value, sub, className = '' }: { label: string; value: ReactNode; sub?: ReactNode; className?: string }) {
  return (
    <div className={className}>
      <div className="eyebrow">{label}</div>
      <div className="mt-1 font-mono text-3xl font-semibold">{value}</div>
      {sub && <div className="mt-0.5 text-sm">{sub}</div>}
    </div>
  )
}

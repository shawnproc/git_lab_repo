import { useCallback, useEffect, useState } from 'react'
import { ApiError, type Freshness, type MarketStatus, api } from '../api'
import { fmtNumber, fmtTimestamp } from '../format'

interface Props {
  onUnauthorized: () => void
}

export function StaleBanner({ items }: { items: { label: string; f: Freshness }[] }) {
  const stale = items.filter((i) => i.f.stale)
  if (stale.length === 0) return null
  return (
    <div
      role="alert"
      className="rounded-xl border-2 border-[var(--color-warn)] bg-[color-mix(in_oklab,var(--color-warn)_14%,transparent)] p-4"
    >
      <div className="font-bold text-[var(--color-warn)]">⚠️ Stale or missing data — don’t act on these numbers</div>
      <ul className="mt-2 space-y-1 text-sm">
        {stale.map((i) => (
          <li key={i.label}>
            <span className="font-semibold">{i.label}:</span> {i.f.reason}
            {i.f.last_error && <span className="muted"> — last error: {i.f.last_error}</span>}
          </li>
        ))}
      </ul>
    </div>
  )
}

function Stat({ label, value, f, digits = 2 }: { label: string; value: number | null; f: Freshness; digits?: number }) {
  return (
    <div className="panel p-5">
      <div className="muted text-xs font-semibold uppercase tracking-wider">{label}</div>
      <div className={`mt-2 font-mono text-3xl font-bold ${f.stale ? 'text-[var(--color-warn)]' : ''}`}>
        {fmtNumber(value, digits)}
      </div>
      <dl className="muted mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt>As of</dt>
        <dd>{f.last_day ?? '—'} {f.stale && <span className="font-semibold text-[var(--color-warn)]">STALE</span>}</dd>
        <dt>Expected</dt>
        <dd>{f.expected_day}</dd>
        <dt>Source</dt>
        <dd>{f.source ?? 'none'}</dd>
        <dt>Fetched</dt>
        <dd>{fmtTimestamp(f.fetched_at)}</dd>
      </dl>
    </div>
  )
}

export function Dashboard({ onUnauthorized }: Props) {
  const [status, setStatus] = useState<MarketStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const run = useCallback(
    async (fn: () => Promise<MarketStatus>) => {
      setBusy(true)
      setError(null)
      try {
        setStatus(await fn())
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          onUnauthorized()
          return
        }
        setError(err instanceof Error ? err.message : 'Request failed')
      } finally {
        setBusy(false)
      }
    },
    [onUnauthorized],
  )

  // Initial load: read the cached status only (no provider calls) once on mount.
  useEffect(() => {
    let cancelled = false
    api.marketStatus().then(
      (s) => {
        if (!cancelled) setStatus(s)
      },
      (err: unknown) => {
        if (cancelled) return
        if (err instanceof ApiError && err.status === 401) onUnauthorized()
        else setError(err instanceof Error ? err.message : 'Request failed')
      },
    )
    return () => {
      cancelled = true
    }
  }, [onUnauthorized])

  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold">Market status</h2>
          <p className="muted text-sm">Phase 1 skeleton: live data plumbing. Picks and regime arrive in Phase 2.</p>
        </div>
        <button className="btn" disabled={busy} onClick={() => void run(api.marketRefresh)}>
          {busy ? 'Refreshing…' : 'Refresh data'}
        </button>
      </div>
      {error && <p role="alert" className="text-[var(--color-down)]">{error}</p>}
      {status && (
        <>
          <StaleBanner
            items={[
              { label: status.benchmark, f: status.benchmark_freshness },
              { label: 'VIX', f: status.vix_freshness },
            ]}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Stat label={`${status.benchmark} close`} value={status.benchmark_close} f={status.benchmark_freshness} />
            <Stat label="VIX (FRED VIXCLS)" value={status.vix} f={status.vix_freshness} />
          </div>
        </>
      )}
    </section>
  )
}

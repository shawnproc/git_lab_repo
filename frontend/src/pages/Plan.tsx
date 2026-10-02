import { useState } from 'react'
import { api, type Plan as PlanData, type ScreenResult, type TargetRow } from '../api'
import { Card, ErrorText, Explain, PageHeader, StatusIcon } from '../components/ui'
import { fmtMoney, fmtPct, fmtTimestamp } from '../format'
import { useApi } from '../useApi'

export const KIND_LABEL = {
  core: 'Safe foundation (core)',
  stock: 'Hand-picked company',
  off_plan: 'Not in your plan',
} as const

function TargetCard({ t, basis }: { t: TargetRow; basis: number }) {
  return (
    <div className="panel p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <span className="font-mono text-lg font-bold">{t.symbol}</span>{' '}
          <span className="muted">{t.name !== t.symbol ? t.name : ''}</span>
        </div>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
            t.kind === 'core'
              ? 'bg-[color-mix(in_oklab,var(--color-brand)_20%,transparent)]'
              : 'bg-[color-mix(in_oklab,var(--color-brand-2)_20%,transparent)]'
          }`}
        >
          {KIND_LABEL[t.kind]}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap gap-6">
        <div>
          <div className="muted text-xs">Share of your money</div>
          <div className="font-mono text-2xl font-bold">{fmtPct(t.target_pct)}</div>
        </div>
        <div>
          <div className="muted text-xs">Dollar amount (of {fmtMoney(basis, false)})</div>
          <div className="font-mono text-2xl font-bold">{fmtMoney(t.target_value)}</div>
        </div>
      </div>
      {t.why && <p className="mt-3 text-sm leading-relaxed">{t.why}</p>}
    </div>
  )
}

function ScreenRow({ r }: { r: ScreenResult }) {
  const [open, setOpen] = useState(false)
  const noData = r.checks.every((c) => c.status === 'unavailable')
  const verdict = r.picked
    ? { text: 'In your plan', cls: 'text-[var(--color-up)]' }
    : noData
      ? { text: 'No report data yet', cls: 'muted' }
      : r.qualifies
      ? { text: 'Passed, but not picked', cls: 'text-[var(--color-brand)]' }
      : { text: 'Didn’t pass', cls: 'muted' }
  return (
    <li className="border-b border-[var(--line)] last:border-0">
      <button
        className="flex w-full flex-wrap items-center justify-between gap-2 py-2 text-left"
        onClick={() => { setOpen(!open) }}
        aria-expanded={open}
      >
        <span>
          <span className="font-mono font-bold">{r.symbol}</span> <span className="muted text-sm">{r.company}</span>
        </span>
        <span className="flex items-center gap-3 text-sm">
          <span aria-hidden>{r.checks.map((c) => <StatusIcon key={c.key} status={c.status} />)}</span>
          <span className={`font-semibold ${verdict.cls}`}>{verdict.text}</span>
          <span className="muted">{open ? '▲' : '▼'}</span>
        </span>
      </button>
      {open && (
        <div className="pb-3 pl-2 text-sm">
          <p className="muted mb-2">Industry: {r.sector}</p>
          {r.note && <p className="mb-2 text-[var(--color-warn)]">{r.note}</p>}
          <ul className="space-y-2">
            {r.checks.map((c) => (
              <li key={c.key} className="flex gap-2">
                <StatusIcon status={c.status} />
                <span>
                  <b>{c.label}</b> {c.detail}
                </span>
              </li>
            ))}
          </ul>
          {r.qualifies && !r.picked && (
            <p className="muted mt-2">
              It passed every test, but other companies scored higher or the plan already has 2 companies from this
              industry.
            </p>
          )}
        </div>
      )}
    </li>
  )
}

export function PlanView({ data }: { data: PlanData }) {
  const core = data.targets.filter((t) => t.kind === 'core')
  const stocks = data.targets.filter((t) => t.kind === 'stock')
  const corePct = core.reduce((a, t) => a + t.target_pct, 0)
  const stockPct = stocks.reduce((a, t) => a + t.target_pct, 0)
  const f = data.fundamentals
  return (
    <div className="space-y-6">
      {data.basis_is_reference && (
        <p className="rounded-lg border border-[var(--line)] p-3 text-sm">
          Dollar amounts below use a pretend <b>{fmtMoney(data.basis_value, false)}</b> because you haven’t entered your
          investments yet. Once you do (on <a className="underline" href="#/money">My Money</a>), they use your real total.
        </p>
      )}
      <Card title={`1. Safe foundation (core): ${fmtPct(corePct, 0)} of your money`}>
        <div className="grid gap-4 md:grid-cols-2">
          {core.map((t) => (
            <TargetCard key={t.symbol} t={t} basis={data.basis_value} />
          ))}
        </div>
        <Explain title="What is the “core” and what are VTI and VXUS?">
          <p>
            A <b>stock</b> is a tiny piece of ownership in one company. An <b>ETF</b> (exchange-traded fund) is a basket
            of many stocks that you buy as one thing, through your broker, just like a stock.
          </p>
          <p>
            <b>VTI</b> holds basically every public company in the US. <b>VXUS</b> holds thousands of companies outside
            the US. Together they’re the <b>core</b>: the big, boring, steady foundation of the plan that doesn’t depend
            on you picking winners.
          </p>
          {stockPct < 40 && stocks.length > 0 && (
            <p>
              The core is a bit bigger than the usual 60% because fewer than 6 companies passed the tests. Their unused
              share moved here instead of piling more money into any one company.
            </p>
          )}
        </Explain>
      </Card>

      <Card title={`2. Hand-picked companies: ${fmtPct(stockPct, 0)} of your money`}>
        {stocks.length === 0 ? (
          <p>
            No companies are picked yet. Click <b>Update company reports</b> above so the app can read the companies’
            official financial reports.
          </p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {stocks.map((t) => (
              <TargetCard key={t.symbol} t={t} basis={data.basis_value} />
            ))}
          </div>
        )}
        <Explain title="How were these companies chosen?">
          <p>
            Every public company must file honest financial reports with the government (the <b>SEC</b>, Securities and
            Exchange Commission). The app reads those reports for free. No opinions, no news.
          </p>
          <p>It starts with 40 well-known large companies and asks each one 5 yes/no questions:</p>
          <ol className="list-decimal space-y-1 pl-5">
            <li><b>Are sales growing?</b> At least 5% more each year over the last 3 years.</li>
            <li><b>Is it profitable?</b> From every $1 of sales it keeps at least 12¢ as profit (before taxes).</li>
            <li><b>Is profit holding up?</b> That profit per $1 isn’t shrinking compared with 2 years ago.</li>
            <li><b>Does real cash come in?</b> After running the business and buying equipment, money is left over.</li>
            <li><b>Is the debt manageable?</b> It could pay off its long-term debt with 3 years of profit or less.</li>
          </ol>
          <p>
            Companies that pass are ranked by growth plus profit, and the top 6 make the plan, with at most 2 from the
            same industry so you’re not all-in on one area. No single company can ever be more than 10% of your money,
            so one bad pick can’t sink you.
          </p>
        </Explain>
      </Card>

      <Card title="All 40 companies we checked">
        <p className="muted mb-3 text-sm">
          ✅ passed · ❌ failed · ➖ the report didn’t include that number, so we skipped it rather than guess. Tap a
          company to see its answers.
        </p>
        <p className="muted mb-3 text-xs">
          Company reports: {f.fetched_at ? `last read ${fmtTimestamp(f.fetched_at)} from ${f.source ?? ''}` : 'not read yet'}
          {f.stale && f.reason ? ` · ${f.reason}` : ''}
          {f.last_error ? ` · last try failed: ${f.last_error}` : ''}
        </p>
        <ul>
          {data.screen.map((r) => (
            <ScreenRow key={r.symbol} r={r} />
          ))}
        </ul>
      </Card>
    </div>
  )
}

export function Plan() {
  const { data, error, loading, busy, run } = useApi(api.plan)
  return (
    <div>
      <PageHeader
        title="My Plan"
        intro="What your money should be split into, and why. Most of it goes in a steady foundation; a smaller part goes to a few strong companies."
        action={
          <button className="btn" disabled={busy || loading} onClick={() => void run(api.refreshPlan)}>
            {busy ? 'Reading company reports… (up to a minute)' : 'Update company reports'}
          </button>
        }
      />
      {error && <ErrorText>{error}</ErrorText>}
      {loading && <p className="muted">Loading…</p>}
      {data?.fundamentals.stale && (
        <p role="alert" className="mb-4 rounded-lg border-2 border-[var(--color-warn)] p-3 text-sm">
          ⚠️ The company reports are {data.fundamentals.fetched_at ? 'out of date' : 'not loaded yet'}. Click{' '}
          <b>Update company reports</b>. The app only re-reads them about once a month, since companies report every
          3 months.
        </p>
      )}
      {data && <PlanView data={data} />}
    </div>
  )
}

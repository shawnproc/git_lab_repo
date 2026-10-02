import { type SubmitEvent, useState } from 'react'
import { api, type ContributionPlan, type Holdings, type HoldingInput } from '../api'
import { Card, ErrorText, Explain, PageHeader, StaleBanner } from '../components/ui'
import { fmtMoney, fmtPct, fmtShares, fmtSignedMoney, gainClass } from '../format'
import { errorMessage, useApi } from '../useApi'
import { KIND_LABEL } from './Plan'

interface Row {
  id: number
  symbol: string
  shares: string
  avg_cost: string
}

let nextId = 1
const blank = (): Row => ({ id: nextId++, symbol: '', shares: '', avg_cost: '' })

/** Turn the form rows into API input, or a list of plain-English problems. */
export function parseRows(rows: Row[]): { holdings: HoldingInput[]; problems: string[] } {
  const holdings: HoldingInput[] = []
  const problems: string[] = []
  const seen = new Set<string>()
  rows.forEach((r, i) => {
    const line = `Line ${String(i + 1)}`
    const symbol = r.symbol.trim().toUpperCase()
    if (!symbol && !r.shares.trim() && !r.avg_cost.trim()) return // empty row: ignore
    if (!/^\^?[A-Z0-9]{1,10}([.-][A-Z0-9]{1,4})?$/.test(symbol)) {
      problems.push(`${line}: “${r.symbol}” doesn’t look like a ticker symbol (like VTI or AAPL).`)
      return
    }
    const shares = Number(r.shares.replace(/,/g, ''))
    const cost = Number(r.avg_cost.replace(/[$,]/g, ''))
    if (!Number.isFinite(shares) || shares <= 0) problems.push(`${line}: number of shares must be more than 0.`)
    if (!Number.isFinite(cost) || cost < 0) problems.push(`${line}: price paid must be a number (0 or more).`)
    if (seen.has(symbol)) problems.push(`${line}: ${symbol} is listed twice. Combine them into one line.`)
    seen.add(symbol)
    holdings.push({ symbol, shares, avg_cost: cost })
  })
  return { holdings, problems }
}

function toRows(h: Holdings): Row[] {
  const rows = h.portfolio.positions.map((p) => ({
    id: nextId++,
    symbol: p.symbol,
    shares: String(p.shares),
    avg_cost: String(p.avg_cost),
  }))
  return rows.length ? rows : [blank()]
}

function HoldingsEditor({ data, onSaved }: { data: Holdings; onSaved: (h: Holdings) => void }) {
  const [rows, setRows] = useState<Row[]>(() => toRows(data))
  const [problems, setProblems] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const update = (id: number, field: keyof Omit<Row, 'id'>, value: string) => {
    setSaved(false)
    setRows(rows.map((r) => (r.id === id ? { ...r, [field]: value } : r)))
  }

  async function save(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault()
    const parsed = parseRows(rows)
    setProblems(parsed.problems)
    if (parsed.problems.length) return
    setSaving(true)
    try {
      const h = await api.saveHoldings(parsed.holdings)
      onSaved(h)
      setRows(toRows(h))
      setSaved(true)
    } catch (err) {
      setProblems([errorMessage(err)])
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card title="Step 1 · What you own">
      <p className="muted mb-3 text-sm">
        Copy these from your broker’s app or website (look for “Positions” or “Holdings”). One line per investment.
      </p>
      <form onSubmit={(e) => void save(e)}>
        <div className="hidden grid-cols-[1fr_1fr_1fr_auto] gap-2 text-xs font-semibold sm:grid">
          <span>Ticker symbol (e.g. VTI)</span>
          <span>How many shares</span>
          <span>Average price you paid, per share</span>
          <span />
        </div>
        {rows.map((r, i) => (
          <div key={r.id} className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
            <input className="input font-mono uppercase" aria-label={`Ticker symbol, line ${String(i + 1)}`} placeholder="VTI"
              value={r.symbol} maxLength={16} onChange={(e) => { update(r.id, 'symbol', e.target.value) }} />
            <input className="input" aria-label={`Shares, line ${String(i + 1)}`} placeholder="10" inputMode="decimal"
              value={r.shares} onChange={(e) => { update(r.id, 'shares', e.target.value) }} />
            <input className="input" aria-label={`Price paid per share, line ${String(i + 1)}`} placeholder="250.00"
              inputMode="decimal" value={r.avg_cost} onChange={(e) => { update(r.id, 'avg_cost', e.target.value) }} />
            <button type="button" className="btn btn-ghost" aria-label={`Remove line ${String(i + 1)}`}
              onClick={() => { setSaved(false); setRows(rows.length > 1 ? rows.filter((x) => x.id !== r.id) : [blank()]) }}>
              Remove
            </button>
          </div>
        ))}
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className="btn btn-ghost" onClick={() => { setRows([...rows, blank()]) }} disabled={rows.length >= 50}>
            + Add another
          </button>
          <button className="btn" disabled={saving}>{saving ? 'Saving and getting prices…' : 'Save'}</button>
          {saved && <span className="self-center text-sm text-[var(--color-up)]">✓ Saved</span>}
        </div>
        {problems.length > 0 && (
          <ul role="alert" className="mt-3 space-y-1 text-sm text-[var(--color-down)]">
            {problems.map((p) => <li key={p}>{p}</li>)}
          </ul>
        )}
      </form>
      <Explain title="Where do I find these numbers?">
        <p>
          A <b>ticker symbol</b> is the short code for an investment: VTI, VXUS, AAPL (Apple), MSFT (Microsoft).
        </p>
        <p>
          <b>Shares</b> is how many you own. It can be a fraction, like 2.35, if your broker lets you buy partial shares.
        </p>
        <p>
          <b>Average price you paid</b> is usually shown as “avg cost” or “cost basis per share”. If you only see a total
          (like “cost basis $2,500” for 10 shares), divide it by your number of shares: $2,500 ÷ 10 = $250.
        </p>
        <p>Everything you type stays on your computer. The app never connects to your broker.</p>
      </Explain>
    </Card>
  )
}

function DriftTable({ data }: { data: Holdings }) {
  const flagged = data.drift.filter((d) => d.flagged)
  if (data.portfolio.positions.length === 0) {
    return (
      <Card title="Step 2 · Are you on track?">
        <p className="muted">Save what you own above and this shows how close you are to your plan.</p>
      </Card>
    )
  }
  return (
    <Card title="Step 2 · Are you on track?">
      <p className="mb-3">
        {flagged.length === 0
          ? '✅ Everything is close to your plan. Nothing to fix.'
          : `⚠️ ${String(flagged.length)} item(s) have drifted from your plan. Your monthly money (Step 3) will fix this gradually. No selling needed.`}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="muted text-left text-xs">
            <tr>
              <th className="py-1 pr-3">Investment</th>
              <th className="py-1 pr-3">Type</th>
              <th className="py-1 pr-3 text-right">Worth now</th>
              <th className="py-1 pr-3 text-right">Your share now</th>
              <th className="py-1 pr-3 text-right">Plan says</th>
              <th className="py-1">Status</th>
            </tr>
          </thead>
          <tbody>
            {data.drift.map((d) => (
              <tr key={d.symbol} className="border-t border-[var(--line)]">
                <td className="py-2 pr-3 font-mono font-bold">{d.symbol}</td>
                <td className="py-2 pr-3">{KIND_LABEL[d.kind]}</td>
                <td className="py-2 pr-3 text-right font-mono">{fmtMoney(d.actual_value)}</td>
                <td className="py-2 pr-3 text-right font-mono">{fmtPct(d.actual_pct)}</td>
                <td className="py-2 pr-3 text-right font-mono">{fmtPct(d.target_pct)}</td>
                <td className={`py-2 ${d.flagged ? 'text-[var(--color-warn)]' : 'text-[var(--color-up)]'}`}>
                  {d.flagged ? `⚠️ ${d.reason}` : d.reason || '✅ on track'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-sm">
        Total gain or loss since you bought:{' '}
        <b className={gainClass(data.portfolio.total_change)}>{fmtSignedMoney(data.portfolio.total_change)}</b>
      </p>
      <Explain title="What is “drift” and what are “percentage points”?">
        <p>
          <b>Drift</b> is when your mix slowly slides away from the plan because some investments grow faster than
          others. Say the plan wants 45% in VTI, but after a great year for everything else you’re at 39%.
        </p>
        <p>
          <b>Percentage points</b> are just the plain difference between two percentages: 45% → 39% is{' '}
          <b>6 percentage points</b> off.
        </p>
        <p>We flag an investment when it is either:</p>
        <ul className="list-disc pl-5">
          <li>more than <b>5 percentage points</b> away from its target, or</li>
          <li>
            more than <b>a quarter</b> away from its own target. This catches small holdings: a company meant to be
            6.7% that grows to 8.5% is only 1.8 points off but 27% bigger than planned.
          </li>
        </ul>
        <p>
          <b>Not in your plan</b> means you own something the plan doesn’t include. That’s okay; it just doesn’t get new
          money.
        </p>
      </Explain>
    </Card>
  )
}

function Contribution() {
  const [amount, setAmount] = useState('500')
  const [result, setResult] = useState<ContributionPlan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault()
    const n = Number(amount.replace(/[$,]/g, ''))
    if (!Number.isFinite(n) || n <= 0) {
      setError('Type an amount more than $0, like 500.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      setResult(await api.contribution(n))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card title="Step 3 · Adding money this month">
      <form onSubmit={(e) => void submit(e)} className="flex flex-wrap items-end gap-2">
        <label className="text-sm">
          How much are you adding?
          <div className="mt-1 flex items-center gap-1">
            <span className="font-mono text-lg">$</span>
            <input className="input w-40 font-mono" inputMode="decimal" value={amount}
              onChange={(e) => { setAmount(e.target.value) }} aria-label="Amount to add in dollars" />
          </div>
        </label>
        <button className="btn" disabled={busy}>{busy ? 'Working it out…' : 'Show me how to split it'}</button>
      </form>
      {error && <p role="alert" className="mt-3 text-[var(--color-down)]">{error}</p>}
      {result && (
        <div className="mt-4">
          <p className="mb-2 font-semibold">Here’s what to buy with your {fmtMoney(result.amount)}:</p>
          <ol className="space-y-2">
            {result.allocations.map((a, i) => (
              <li key={a.symbol} className="panel flex flex-wrap items-baseline justify-between gap-2 p-3">
                <span>
                  <span className="muted mr-2">{i + 1}.</span>
                  Buy <b className="font-mono">{fmtMoney(a.amount)}</b> of <b className="font-mono">{a.symbol}</b>
                </span>
                <span className="muted text-sm">
                  {a.shares !== null && a.price !== null
                    ? `≈ ${fmtShares(a.shares)} shares at about ${fmtMoney(a.price)} each`
                    : 'no current price yet'}
                </span>
              </li>
            ))}
          </ol>
          {result.leftover > 0.005 && (
            <p className="mt-2 text-sm">Left over: <b>{fmtMoney(result.leftover)}</b>. Keep it in cash for next month.</p>
          )}
          {result.note && <p className="muted mt-2 text-sm">{result.note}</p>}
          <p className="muted mt-2 text-xs">
            Prices move during the day, so share counts are approximate. In your broker, you can usually buy “in dollars”
            and type the dollar amount exactly.
          </p>
        </div>
      )}
      <Explain title="How does it decide where the money goes?">
        <p>
          It looks at which investments are furthest <b>below</b> their target and sends the money there first. Over a
          few months that brings everything back to the plan without you ever having to sell. (Selling can mean
          paying taxes.)
        </p>
        <p>
          It uses <b>fractional shares</b> by default: buying $100 of a $400 stock gets you ¼ share. Most big brokers
          (like Fidelity, Schwab and Robinhood) allow this. If yours doesn’t, the setting can switch to whole shares.
        </p>
      </Explain>
    </Card>
  )
}

export function Money() {
  const { data, error, setData } = useApi(api.holdings)
  return (
    <div>
      <PageHeader
        title="My Money"
        intro="Three steps: tell the app what you own, see whether you’re on track, and get a split for the money you’re adding this month."
      />
      {error && <ErrorText>{error}</ErrorText>}
      {data && (
        <div className="space-y-6">
          <StaleBanner items={Object.entries(data.freshness).map(([sym, f]) => ({ label: sym, f }))} />
          <HoldingsEditor data={data} onSaved={setData} />
          <DriftTable data={data} />
          <Contribution />
        </div>
      )}
    </div>
  )
}

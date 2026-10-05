// The Search tab: look up any big US company, see how it measures up to the plan's rules, save it
// to a watchlist, and (for a "Good fit") add it to your buy days. Verdicts are the plan's own
// checks applied to official reports; they're not predictions and never tell you to buy or sell.
import { type ReactNode, type SubmitEvent, useEffect, useMemo, useState } from 'react'
import { Card, Explain, PageHeader, StatusIcon } from '../components/ui'
import { fmtDay, fmtMoney, fmtPct, fmtSignedPct, fmtTimestamp, gainClass } from '../format'
import { type LiveQuote, saveKey, validKey } from './live'
import { useLive } from './LiveContext'
import { type Company, fmtBig, type Research, searchCompanies, type Verdict, VERDICT_WORDS } from './research'
import { MAX_INCLUDED, MAX_WATCH, type PhoneData, type WatchItem } from './store'

/** Where the watchlist lives: the phone's storage, or the PC app's database. */
export interface Watch {
  items: WatchItem[]
  add: (c: Company) => void
  remove: (symbol: string) => void
  setInclude: (symbol: string, on: boolean) => void
  device: 'phone' | 'computer'
}

/** The phone's watchlist, kept in its PhoneData. */
export function phoneWatch(data: PhoneData, update: (d: PhoneData) => void): Watch {
  const set = (watchlist: WatchItem[]) => { update({ ...data, watchlist }) }
  return {
    items: data.watchlist,
    add: (c) => { set([...data.watchlist, { symbol: c.s, added_at: new Date().toISOString(), added_price: c.close, verdict_at_add: c.v, include: false }]) },
    remove: (sym) => { set(data.watchlist.filter((w) => w.symbol !== sym)) },
    setInclude: (sym, on) => { set(data.watchlist.map((w) => (w.symbol === sym ? { ...w, include: on } : w))) },
    device: 'phone',
  }
}

const MARK: Record<Verdict, string> = { fit: '✓', pricey: '◐', no: '✕', unknown: '?', fund: '▦' }
const TONE: Record<Verdict, string> = {
  fit: 'border-[var(--color-up)] text-[var(--color-up)]',
  pricey: 'border-[var(--color-warn)] text-[var(--color-warn)]',
  no: 'border-[var(--color-down)] text-[var(--color-down)]',
  unknown: 'border-[var(--line)] muted',
  fund: 'border-[var(--color-brand)] text-[var(--color-brand)]',
}

export function VerdictBadge({ v }: { v: Verdict }) {
  return (
    <span className={`inline-flex items-center gap-1 border-2 px-2 py-0.5 text-xs font-bold ${TONE[v]}`}>
      <span aria-hidden>{MARK[v]}</span>{VERDICT_WORDS[v]}
    </span>
  )
}

const asVerdict = (s: string): Verdict => (s in VERDICT_WORDS ? (s as Verdict) : 'unknown')

/** The price to show: live (if you set up a key) or the last close, always labelled which. */
function Price({ c, live }: { c: Company; live?: LiveQuote }) {
  const price = live?.price ?? c.close
  const chg = live ? live.change_pct : c.chg
  return (
    <div>
      <div className="serif text-4xl font-bold tabular-nums">{fmtMoney(price)}</div>
      <div className={`font-mono text-sm ${gainClass(chg)}`}>
        <span aria-hidden>{(chg ?? 0) > 0 ? '▲ ' : (chg ?? 0) < 0 ? '▼ ' : ''}</span>{fmtSignedPct(chg)}
        <span className="muted ml-2 font-sans text-xs">
          {live ? <><b className="text-[var(--color-up)]">● Live</b> · {fmtTimestamp(live.at)}</> : c.day ? `At the close on ${fmtDay(c.day)}` : 'No price today'}
        </span>
      </div>
    </div>
  )
}

function Detail({ c, live, item, watch, chart }: {
  c: Company; live?: LiveQuote; item?: WatchItem; watch: Watch; chart?: ReactNode
}) {
  const [msg, setMsg] = useState<string | null>(null)
  const watchlist = watch.items
  function add() {
    if (watchlist.length >= MAX_WATCH) { setMsg(`Your watchlist is full (${String(MAX_WATCH)}). Remove one first.`); return }
    watch.add(c)
    setMsg('✓ Saved to your watchlist, below.')
  }
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="eyebrow">{c.s}</div>
          <h3 className="serif text-2xl font-bold leading-tight">{c.n}</h3>
        </div>
        <VerdictBadge v={c.v} />
      </div>
      <div className="mt-3"><Price c={c} live={live} /></div>
      <p className="serif mt-3 text-lg leading-snug">{c.h}</p>
      {c.v !== 'fund' && (
        <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
          <div><dt className="eyebrow">Yearly sales{c.y ? ` (${String(c.y)})` : ''}</dt><dd className="font-mono">{fmtBig(c.rev)}</dd></div>
          <div><dt className="eyebrow">Dividend</dt><dd className="font-mono">{c.dy ? `${fmtPct(c.dy, 2)} a year` : 'none'}</dd></div>
        </dl>
      )}
      {c.v === 'fund' && c.dy ? <p className="mt-2 text-sm">Dividend: {fmtPct(c.dy, 2)} a year.</p> : null}
      {c.pe_note && <p className={`mt-3 text-sm ${c.pe_flag ? 'font-semibold text-[var(--color-warn)]' : ''}`}><b>Price check:</b> {c.pe_note}</p>}
      {c.checks && c.checks.length > 0 && (
        <ul className="mt-3 space-y-2 text-sm">
          {c.checks.map(([label, status, detail]) => (
            <li key={label} className="flex gap-2"><StatusIcon status={status} /><span><b>{/[?:]$/.test(label) ? label : `${label}:`}</b> {detail}</span></li>
          ))}
        </ul>
      )}
      {chart && <div className="mt-4">{chart}</div>}
      <div className="mt-4">
        {item ? <p className="text-sm">★ On your watchlist since {fmtDay(item.added_at.slice(0, 10))}.</p>
          : <button type="button" className="btn w-full" onClick={add}>Add {c.s} to my watchlist</button>}
        {msg && <p role="status" className="mt-2 text-sm">{msg}</p>}
      </div>
      <Explain title="What do these verdicts mean?">
        <p><b>Good fit</b>: it passes all 5 of the plan’s quality checks on its latest yearly report, and its price looks normal for it.</p>
        <p><b>Good business, pricey right now</b>: it passes the checks, but you’re paying a lot more per $1 of profit than usual for it. Worth watching for a calmer price.</p>
        <p><b>Not a fit</b>: it misses at least one check. That doesn’t mean it’s a bad company or that its stock will fall, only that it doesn’t match this plan’s rules.</p>
        <p>These come from the company’s official SEC reports, checked the same way as the plan’s own picks. They’re not predictions and not advice to buy or sell.</p>
      </Explain>
    </Card>
  )
}

function Watchlist({ research, watch, live, open }: {
  research: Research | null; watch: Watch; live: Record<string, LiveQuote>; open: (s: string) => void
}) {
  const by = useMemo(() => new Map((research?.companies ?? []).map((c) => [c.s, c])), [research])
  const included = watch.items.filter((w) => w.include).length
  if (watch.items.length === 0) {
    return <Card title="My watchlist"><p className="muted text-sm">Search a company and tap <b>Add to my watchlist</b> to follow it here.</p></Card>
  }
  return (
    <Card title="My watchlist">
      <ul className="divide-y divide-[var(--line)]">
        {watch.items.map((w) => {
          const c = by.get(w.symbol)
          const now = live[w.symbol]?.price ?? c?.close ?? null
          const since = now !== null && w.added_price ? (now / w.added_price - 1) * 100 : null
          const was = asVerdict(w.verdict_at_add)
          const changed = c && c.v !== was
          const canInclude = c?.v === 'fit'
          return (
            <li key={w.symbol} className="py-3 text-sm">
              <div className="flex items-center gap-3">
                <button type="button" className="w-16 text-left font-mono font-bold underline" onClick={() => { open(w.symbol) }}>{w.symbol}</button>
                <span className="min-w-0 flex-1">
                  {c ? <VerdictBadge v={c.v} /> : <span className="muted text-xs">Not in today’s search data</span>}
                </span>
                <span className="text-right font-mono">
                  {fmtMoney(now)}
                  <span className={`block text-xs ${gainClass(since)}`}>{since === null ? '' : `${fmtSignedPct(since)} since added`}</span>
                </span>
              </div>
              {changed && <p className="mt-1 text-xs font-semibold text-[var(--color-warn)]">Changed: it was “{VERDICT_WORDS[was]}” when you saved it.</p>}
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                <label className={`flex items-center gap-2 text-xs ${canInclude ? '' : 'muted'}`}>
                  <input type="checkbox" checked={w.include && canInclude} disabled={!canInclude || (!w.include && included >= MAX_INCLUDED)}
                    onChange={(e) => { watch.setInclude(w.symbol, e.target.checked) }} />
                  Include in my buy days
                </label>
                <button type="button" className="btn btn-ghost px-2 py-1 text-xs" onClick={() => { watch.remove(w.symbol) }} aria-label={`Remove ${w.symbol} from my watchlist`}>Remove</button>
              </div>
              {w.include && !canInclude && c && <p className="mt-1 text-xs">Paused: it’s no longer a “Good fit”, so it gets no new money. It comes back by itself if that changes.</p>}
            </li>
          )
        })}
      </ul>
      <Explain title="How do watchlist picks join my buy days?">
        <p>Switch on <b>Include in my buy days</b> for a “Good fit” and it joins your plan’s stocks. Your stock share of each buy is then split among all of them, so no single company ever gets more than the plan’s per-company limit.</p>
        <p>Up to {String(MAX_INCLUDED)} picks can be included. If a pick stops being a “Good fit”, it’s paused automatically: no new money, and nothing is ever sold for you.</p>
        <p>“Since added” compares today’s price with its last close on the day you saved it.</p>
      </Explain>
    </Card>
  )
}

function LiveSetup({ device }: { device: Watch['device'] }) {
  const { key: keyNow, setKey, error, checkedAt } = useLive()
  const [draft, setDraft] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  function submit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault()
    const k = draft.trim()
    if (!validKey(k)) { setMsg('That doesn’t look like a Finnhub key (letters and numbers only).'); return }
    if (!saveKey(k)) { setMsg(`Couldn’t save it on this ${device} (private mode?).`); return }
    setKey(k)
    setDraft('')
    setMsg('✓ Live prices are on.')
  }
  return (
    <Card>
      <div className="eyebrow">Live prices</div>
      {keyNow ? (
        <div className="mt-1 flex items-center justify-between gap-3 text-sm">
          <span><b className="text-[var(--color-up)]">● On</b> · your key ends in …{keyNow.slice(-4)}</span>
          <button type="button" className="btn btn-ghost px-2 py-1 text-xs" onClick={() => { saveKey(null); setKey(null); setMsg('Live prices are off.') }}>Turn off</button>
        </div>
      ) : (
        <form onSubmit={submit} className="mt-2 flex gap-2">
          <input className="input min-w-0 flex-1" type="password" autoComplete="off" spellCheck={false} placeholder="Paste your Finnhub key"
            value={draft} onChange={(e) => { setDraft(e.target.value) }} aria-label="Finnhub API key" />
          <button className="btn">Turn on</button>
        </form>
      )}
      {msg && <p role="status" className="mt-2 text-sm">{msg}</p>}
      {keyNow && (
        <p className="mt-2 text-sm" data-testid="live-status">
          {error ? <span className="font-semibold text-[var(--color-down)]">✕ Not working: {error}</span>
            : checkedAt ? <span className="text-[var(--color-up)]">✓ Working · last live price {fmtTimestamp(checkedAt)}</span>
              : <span className="muted">Checking your key…</span>}
        </p>
      )}
      <Explain title="How do live prices work?">
        <p>Without a key you see each company’s price at the last market close. With a free key from <a className="underline" href="https://finnhub.io/register" target="_blank" rel="noreferrer noopener">finnhub.io</a>, Today, Search and your watchlist show the price right now, refreshed every minute while the app is open (only while the market is open does the price move). Today also draws your money’s line for the day, starting when you open the app.</p>
        <p>Your key is saved in this {device}’s browser only. It isn’t in the app’s code, the public data or your backup file, so on another device, paste it in again.</p>
        <p><b>Live prices are for looking only.</b> Your buy amounts and days always use the last close, so a price moving minute to minute never changes your plan.</p>
      </Explain>
    </Card>
  )
}

export function SearchPage({ research, error, watch, chart }: {
  research: Research | null; error: string | null; watch: Watch; chart: (symbol: string) => ReactNode
}) {
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  const { quotes: live, error: liveError, setFocus } = useLive()
  const results = useMemo(() => (research ? searchCompanies(research.companies, query) : []), [research, query])
  const company = picked && research ? research.companies.find((c) => c.s === picked) : undefined
  useEffect(() => { setFocus(picked); return () => { setFocus(null) } }, [picked, setFocus])
  const open = (s: string) => { setPicked(s); setQuery(''); window.scrollTo(0, 0) }
  return (
    <div className="space-y-5">
      <PageHeader title="Search" intro="Look up any big US company and see how it measures up to your plan’s rules." />
      <Card>
        <label className="block text-sm font-semibold" htmlFor="search-box">Company or ticker</label>
        <input id="search-box" className="input mt-1 w-full" type="search" inputMode="search" autoComplete="off" autoCapitalize="characters"
          placeholder="Apple or AAPL" value={query} maxLength={40} onChange={(e) => { setQuery(e.target.value) }} />
        {error && <p role="alert" className="mt-2 text-sm">{error}</p>}
        {!research && !error && <p className="muted mt-2 text-sm">Loading the company list…</p>}
        {research && (
          <p className="muted mt-2 text-xs">
            {research.companies.length.toLocaleString('en-US')} companies and funds · reports and closes updated {fmtTimestamp(research.generated_at)}
          </p>
        )}
        {query && research && (
          results.length === 0 ? <p className="mt-3 text-sm">No match. Search covers US companies with over {fmtBig(research.min_revenue_usd)} in yearly sales, plus funds the app tracks.</p> : (
            <ul className="mt-3 divide-y divide-[var(--line)]">
              {results.map((c) => (
                <li key={c.s}>
                  <button type="button" className="flex w-full items-center gap-3 py-2 text-left text-sm" onClick={() => { open(c.s) }}>
                    <span className="w-16 font-mono font-bold">{c.s}</span>
                    <span className="muted min-w-0 flex-1 truncate text-xs">{c.n}</span>
                    <span aria-label={VERDICT_WORDS[c.v]} className={`font-bold ${TONE[c.v]} border-0`}>{MARK[c.v]}</span>
                  </button>
                </li>
              ))}
            </ul>
          )
        )}
      </Card>
      {liveError && <p role="alert" className="text-sm">{liveError}</p>}
      {company && <Detail c={company} live={live[company.s]} item={watch.items.find((w) => w.symbol === company.s)} watch={watch} chart={chart(company.s)} />}
      <Watchlist research={research} watch={watch} live={live} open={open} />
      <LiveSetup device={watch.device} />
    </div>
  )
}

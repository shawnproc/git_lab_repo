// The company dossier: everything public that hints at what insiders and pros know, in one place.
// 1 insider trades, 2 the latest quarter, 3 big-event filings, 4 size and price, 5 analysts and news.
import { useEffect, useState } from 'react'
import { Card, Explain } from '../components/ui'
import { fmtDay, fmtMoney, fmtSignedPct, fmtTimestamp } from '../format'
import { EVENT_WORDS, type Dossier, fetchDossier, filingLink, sizeWord, summarize, type Tone } from './dossier'
import { fetchNews, fetchRatings, LiveError, type NewsItem, type Ratings } from './live'
import { useLive } from './LiveContext'
import { type Company, fmtBig } from './research'

const TONE: Record<Tone, string> = { red: 'text-[var(--color-down)]', watch: 'text-[var(--color-warn)]', info: '' }
const MARK: Record<Tone, string> = { red: '▲!', watch: '●', info: '·' }
const cents = (x: number) => `${x.toFixed(1)}¢`

function Section({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-[var(--line)] pt-4 first:border-t-0 first:pt-0">
      <div className="eyebrow">{String(n)} · {title}</div>
      <div className="mt-2 space-y-2 text-sm">{children}</div>
    </section>
  )
}

function Insiders({ d, c }: { d: Dossier | null; c: Company }) {
  if (!d) return <p className="muted">Loading insider filings…</p>
  const rows = d.companies[c.s]?.t ?? []
  const s = summarize(rows)
  const covered = d.days.length
  return (
    <>
      {covered < 40 && <p className="muted text-xs">Still filling in: {String(covered)} filing days read so far of the last {String(d.window_days)} calendar days. It completes over the next couple of weeks.</p>}
      {rows.length === 0 ? <p>No open-market insider buys or sells filed {covered ? 'in the days read so far' : 'yet'}.</p> : (
        <>
          {s.cluster && <p className="rounded-xl border border-[var(--color-up)] p-2 font-semibold text-[var(--color-up)]">▲ Cluster buying: {String(s.buyers)} different insiders bought with their own money within a month.</p>}
          <p>
            Insiders <b>bought {fmtMoney(s.bought, false)}</b> ({String(s.buys)} {s.buys === 1 ? 'purchase' : 'purchases'}) and <b>sold {fmtMoney(s.sold, false)}</b>
            {s.sold > 0 ? (s.soldUnplanned === 0 ? ', all of it through pre-set plans' : s.soldUnplanned === s.sold ? ', none of it planned in advance' : `, ${fmtMoney(s.soldUnplanned, false)} of it not planned in advance`) : ''}.
          </p>
          <ul className="space-y-1">
            {rows.slice(0, 8).map((t) => (
              <li key={t.join('|')} className="flex items-start gap-2">
                <span aria-hidden className={t[3] === 'P' ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}>{t[3] === 'P' ? '▲' : '▼'}</span>
                <span><b>{t[3] === 'P' ? 'Bought' : 'Sold'} {fmtMoney(t[5], false)}</b> · {t[1]} ({t[2]}) · {fmtDay(t[0])}{t[6] ? ' · planned sale' : ''}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  )
}

function Quarter({ c }: { c: Company }) {
  if (!c.qp || c.qg === null || c.qg === undefined) return <p>No quarterly comparison in its SEC data yet.</p>
  const [y, q] = c.qp.split('Q')
  const margin = c.qom !== null && c.qom !== undefined && c.qom0 !== null && c.qom0 !== undefined
  return (
    <>
      <p>In Q{q} {y}, sales were <b className={c.qg >= 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'}>{fmtSignedPct(c.qg, 1)}</b> vs the same quarter a year earlier{c.g3 !== null && c.g3 !== undefined ? ` (its 3-year pace: ${c.g3.toFixed(0)}% a year)` : ''}.</p>
      {margin && <p>Profit per $1 of sales: <b>{cents(c.qom ?? 0)}</b>, vs {cents(c.qom0 ?? 0)} a year earlier{(c.qom ?? 0) < (c.qom0 ?? 0) - 2 ? ': shrinking' : (c.qom ?? 0) > (c.qom0 ?? 0) + 2 ? ': growing' : ''}.</p>}
      {c.g3 !== null && c.g3 !== undefined && c.qg < c.g3 - 10 && <p className="text-[var(--color-warn)]">● Growth this quarter is well below its usual pace. Slowdowns often show here first.</p>}
    </>
  )
}

function Events({ d, c }: { d: Dossier | null; c: Company }) {
  if (!d) return <p className="muted">Loading filings…</p>
  const rows = d.companies[c.s]?.e ?? []
  if (rows.length === 0) return <p>No major-event filings {d.days.length ? 'in the days read so far' : 'yet'}.</p>
  return (
    <ul className="space-y-2">
      {rows.slice(0, 8).map(([day, items, path]) => {
        const link = filingLink(path)
        return (
          <li key={path}>
            <div className="muted text-xs">{fmtDay(day)}{link && <> · <a className="underline" href={link} target="_blank" rel="noreferrer noopener">the filing</a></>}</div>
            {items.split(',').map((code) => {
              const [words, tone] = EVENT_WORDS[code] ?? [`Item ${code}`, 'info']
              return <div key={code} className={TONE[tone]}><span aria-hidden>{MARK[tone]} </span>{words}</div>
            })}
          </li>
        )
      })}
    </ul>
  )
}

function Price({ c }: { c: Company }) {
  const size = sizeWord(c.mcap)
  return (
    <>
      {c.mcap ? <p>Worth about <b>{fmtBig(c.mcap)}</b> in total. {size}.</p> : <p>Total value not available (no share count in its reports, or a recent stock split).</p>}
      {c.ps ? <p>You pay about <b>${c.ps.toFixed(c.ps < 10 ? 1 : 0)}</b> for each $1 of its yearly sales.{c.g3 !== null && c.g3 !== undefined ? ` For that to make sense, sales usually need to keep growing fast (lately about ${c.g3.toFixed(0)}% a year).` : ''}</p> : null}
      {c.pe_note && <p>{c.pe_note}</p>}
    </>
  )
}

function Pros({ c }: { c: Company }) {
  const { key } = useLive()
  const [ratings, setRatings] = useState<Ratings[] | null>(null)
  const [news, setNews] = useState<NewsItem[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    if (!key || c.v === 'fund') return
    let off = false
    const msg = (e: unknown) => (e instanceof LiveError ? e.message : 'Couldn’t load this.')
    fetchRatings(c.s, key).then((r) => { if (!off) setRatings(r) }, (e: unknown) => { if (!off) setErr(msg(e)) })
    fetchNews(c.s, key, new Date()).then((n) => { if (!off) setNews(n) }, (e: unknown) => { if (!off) setErr(msg(e)) })
    return () => { off = true }
  }, [key, c.s, c.v])
  if (!key) return <p className="muted">Add your free Finnhub key (Search → Live prices) to see analyst ratings and recent news here.</p>
  const r = ratings?.[0]
  const total = r ? r.strongBuy + r.buy + r.hold + r.sell + r.strongSell : 0
  const prev = ratings?.[1]
  return (
    <>
      {err && <p className="muted">{err}</p>}
      {r && total > 0 && (
        <div>
          <p><b>{String(total)} analysts</b> ({fmtDay(r.period)}): {String(r.strongBuy + r.buy)} say buy, {String(r.hold)} hold, {String(r.sell + r.strongSell)} sell.
            {prev ? ` A month earlier: ${String(prev.strongBuy + prev.buy)} buy, ${String(prev.hold)} hold, ${String(prev.sell + prev.strongSell)} sell.` : ''}</p>
          <div className="mt-1 flex h-2.5 overflow-hidden rounded-full" role="img" aria-label={`${String(r.strongBuy + r.buy)} buy, ${String(r.hold)} hold, ${String(r.sell + r.strongSell)} sell`}>
            <div style={{ width: `${String(((r.strongBuy + r.buy) / total) * 100)}%`, background: 'var(--color-up)' }} />
            <div style={{ width: `${String((r.hold / total) * 100)}%`, background: 'var(--muted)' }} />
            <div style={{ width: `${String(((r.sell + r.strongSell) / total) * 100)}%`, background: 'var(--color-down)' }} />
          </div>
        </div>
      )}
      {ratings && !r && <p>No analyst ratings for this company.</p>}
      {news && news.length > 0 && (
        <ul className="space-y-2">
          {news.map((n) => (
            <li key={n.url}><a className="underline" href={n.url} target="_blank" rel="noreferrer noopener">{n.headline}</a><div className="muted text-xs">{n.source} · {fmtTimestamp(n.at)}</div></li>
          ))}
        </ul>
      )}
      {news && news.length === 0 && <p>No news in the last two weeks.</p>}
    </>
  )
}

export function DossierCard({ c }: { c: Company }) {
  const [d, setD] = useState<Dossier | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let off = false
    fetchDossier().then((x) => { if (!off) setD(x) }, (e: unknown) => { if (!off) setErr(e instanceof Error ? e.message : 'Couldn’t load the filings.') })
    return () => { off = true }
  }, [])
  if (c.v === 'fund') return null
  return (
    <Card title="Company dossier">
      <div className="space-y-4">
        <Section n={1} title="What insiders did with their own money">{err ? <p className="muted">{err}</p> : <Insiders d={d} c={c} />}</Section>
        <Section n={2} title="The latest quarter"><Quarter c={c} /></Section>
        <Section n={3} title="Big events it had to report">{err ? <p className="muted">{err}</p> : <Events d={d} c={c} />}</Section>
        <Section n={4} title="Size and price"><Price c={c} /></Section>
        <Section n={5} title="What the pros say, and the news"><Pros c={c} /></Section>
      </div>
      <Explain title="How do I read the dossier?">
        <p><b>Insiders</b> (executives, directors, big owners) must report their trades to the SEC within two business days. Buying with their own money, especially several of them at once, is one of the better-studied signals. Selling means less: they sell for taxes, houses and planned diversification (“planned sale” = set up months in advance).</p>
        <p><b>The latest quarter</b> shows a slowdown months before the yearly numbers do.</p>
        <p><b>Big events</b> come from the 8-K form companies must file within four business days. Red marks are the serious ones: bankruptcy, delisting warnings, a new auditor, restated results.</p>
        <p><b>Size and price</b>: the smaller the company, the bigger the swings. A high price per $1 of sales means the market expects a lot of growth.</p>
        <p><b>The pros</b>: analyst ratings tend to lean toward “buy”, so a change over time says more than the count.</p>
        <p>All of this is public. None of it tells you where the price goes next; it helps you decide with your eyes open. Using private, non-public information to trade is illegal.</p>
        {d && <p className="muted text-xs">Filings: SEC EDGAR, read {fmtTimestamp(d.generated_at)}. Quarterly and size: SEC reports and the last close.</p>}
      </Explain>
    </Card>
  )
}

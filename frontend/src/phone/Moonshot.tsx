// The Moonshot side's screens: Bets (with the risk budget), Sell & taxes, and Learn.
import { type SubmitEvent, useEffect, useState } from 'react'
import { Card, Explain, PageHeader } from '../components/ui'
import { fmtDay, fmtMoney, fmtPct, fmtShares, fmtSignedMoney, gainClass } from '../format'
import { useLive } from './LiveContext'
import { betProblems, budgetOf, MAX_BET_SHARE, MAX_BUDGET_PCT, type MoonBet, type Moonshot, milestone, multiple } from './moonshot'
import { type Dossier, fetchDossier } from './dossier'
import { BIG_MIN, FAST_GROWTH, INSIDER_MIN, insidersBuying, MARGIN_DROP, type RadarRow, SMALL_MAX, underTheRadar, warningSigns } from './radar'
import { fmtBig, type Research } from './research'
import { VerdictBadge } from './Search'
import { newId } from './store'
import { estimateSale, FILING_WORDS, type FilingStatus, LOSS_LIMIT, longTermFrom, sharesToRecoverCost, TABLES, TAX_SOURCE, TAX_SOURCE_URL, TAX_YEAR } from './tax'

const todayLocal = () => {
  const d = new Date()
  return `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)
const fmtX = (x: number | null) => (x === null ? '—' : `${x >= 10 ? x.toFixed(0) : x.toFixed(2)}x`)

/** Price per share now: live (with your key), else the last close we have. */
export type PriceOf = (symbol: string) => { price: number; live: boolean } | null

function usePrice(closes: Record<string, number>): PriceOf {
  const { quotes } = useLive()
  return (s) => {
    const q = quotes[s]
    if (q) return { price: q.price, live: true }
    const c = closes[s]
    return c === undefined ? null : { price: c, live: false }
  }
}

const CHECKS = [
  'I could lose every dollar I put into a moonshot, and I’d be okay.',
  'This money is separate from my long-term plan. I won’t sell plan holdings to fund it.',
  'Nobody can reliably pick the stock that goes up 16x. For every one that does, many go to zero.',
  'Selling for a gain creates a tax bill, and selling within a year usually costs more tax.',
]

function Checklist({ m, set }: { m: Moonshot; set: (m: Moonshot) => void }) {
  const [ticked, setTicked] = useState<boolean[]>(CHECKS.map(() => false))
  return (
    <Card>
      <div className="eyebrow">Before you start</div>
      <h3 className="serif mt-1 text-2xl">The Moonshot side is for money you can lose.</h3>
      <p className="mt-2 text-sm">Big, fast gains come from the riskiest bets: tiny companies, brand-new stocks, startups. Most of them fail. This side helps you size bets so a loss can’t hurt your future, track them, and understand selling and taxes. It never tells you what to buy.</p>
      <ul className="mt-4 space-y-3 text-sm">
        {CHECKS.map((c, i) => (
          <li key={c}><label className="flex gap-3">
            <input type="checkbox" className="mt-1" checked={ticked[i] ?? false} onChange={(e) => { setTicked(ticked.map((t, j) => (j === i ? e.target.checked : t))) }} />
            <span>{c}</span>
          </label></li>
        ))}
      </ul>
      <button type="button" className="btn mt-5 w-full" disabled={!ticked.every(Boolean)} onClick={() => { set({ ...m, ack_at: new Date().toISOString() }) }}>I understand. Open the Moonshot side</button>
    </Card>
  )
}

function BudgetCard({ m, set, planValue }: { m: Moonshot; set: (m: Moonshot) => void; planValue: number }) {
  const b = budgetOf(m, planValue)
  const usedPct = b.budget > 0 ? Math.min(100, (b.used / b.budget) * 100) : 0
  return (
    <Card>
      <div className="eyebrow">Your risk budget</div>
      <div className="mt-1 flex items-end justify-between gap-3">
        <div className="serif text-4xl">{fmtMoney(b.room)}</div>
        <div className="muted text-right text-xs">room left for new bets</div>
      </div>
      <div className="mt-3 h-3 overflow-hidden rounded-full bg-[var(--panel-2)]" role="img" aria-label={`${usedPct.toFixed(0)}% of your moonshot budget is used`}>
        <div className="h-full rounded-full" style={{ width: `${String(usedPct)}%`, background: 'linear-gradient(90deg, var(--grad-a), var(--grad-b))' }} />
      </div>
      <dl className="mt-3 grid grid-cols-3 gap-2 text-sm">
        <div><dt className="eyebrow">Budget</dt><dd className="font-mono">{fmtMoney(b.budget, false)}</dd></div>
        <div><dt className="eyebrow">Put in</dt><dd className="font-mono">{fmtMoney(b.used, false)}</dd></div>
        <div><dt className="eyebrow">Max per bet</dt><dd className="font-mono">{fmtMoney(b.perBet, false)}</dd></div>
      </dl>
      <label className="mt-4 block text-sm">Share of everything you have that moonshots may hold: <b>{String(m.budget_pct)}%</b>
        <input type="range" min={1} max={MAX_BUDGET_PCT} step={1} value={m.budget_pct} className="mt-2 w-full" aria-label="Moonshot budget, percent of everything"
          onChange={(e) => { set({ ...m, budget_pct: Number(e.target.value) }) }} />
      </label>
      <Explain title="How does the budget protect me?">
        <p>Everything you have = your long-term holdings ({fmtMoney(planValue, false)}) plus what you’ve put into moonshots. Moonshots may hold at most the share you pick, never more than {String(MAX_BUDGET_PCT)}%. Bets count at what you paid, so a lucky run-up doesn’t give you more to gamble with.</p>
        <p>No single bet can be more than {String(MAX_BET_SHARE * 100)}% of the budget, so one blow-up can’t take it all. If you lost every moonshot, your long-term plan would still be at least {String(100 - m.budget_pct)}% intact.</p>
        <p>The app refuses to log a bet that breaks these limits. It can’t stop your broker, so the real guardrail is you checking here first.</p>
      </Explain>
    </Card>
  )
}

function AddBet({ m, set, planValue }: { m: Moonshot; set: (m: Moonshot) => void; planValue: number }) {
  const [symbol, setSymbol] = useState('')
  const [kind, setKind] = useState<'stock' | 'private'>('stock')
  const [cost, setCost] = useState('')
  const [shares, setShares] = useState('')
  const [bought, setBought] = useState(todayLocal())
  const [problems, setProblems] = useState<string[]>([])
  function submit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault()
    const sym = symbol.trim().toUpperCase().replace(/\s+/g, ' ')
    const amount = Number(cost.replace(/[$,\s]/g, ''))
    const n = Number(shares.replace(/[,\s]/g, ''))
    const p = betProblems(m, planValue, amount, sym)
    if (!/^[A-Z0-9][A-Z0-9 .&-]{0,23}$/.test(sym)) p.unshift(kind === 'stock' ? 'Type the ticker, like PLTR.' : 'Type a short name for the company.')
    if (!(n > 0)) p.push('Type how many shares you got.')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(bought) || bought > todayLocal()) p.push('Pick the day you bought it (not in the future).')
    setProblems(p)
    if (p.length) return
    const bet: MoonBet = { id: newId(), symbol: sym, kind, shares: n, cost: Math.round(amount * 100) / 100, bought, value: kind === 'private' ? Math.round(amount * 100) / 100 : null, value_at: kind === 'private' ? bought : null }
    set({ ...m, bets: [...m.bets, bet] })
    setSymbol(''); setCost(''); setShares('')
  }
  return (
    <Card title="Log a bet you made">
      <form onSubmit={submit} className="space-y-3 text-sm">
        <div role="group" aria-label="Kind of company" className="flex gap-2">
          {(['stock', 'private'] as const).map((k) => (
            <button key={k} type="button" aria-pressed={kind === k} onClick={() => { setKind(k) }}
              className={`btn-ghost btn flex-1 px-3 py-2 text-xs ${kind === k ? 'border-[var(--color-brand-2)]' : ''}`}>{k === 'stock' ? 'Public stock' : 'Private startup'}</button>
          ))}
        </div>
        <label className="block">{kind === 'stock' ? 'Ticker' : 'Company name'}<input className="input mt-1" value={symbol} maxLength={24} autoCapitalize="characters" onChange={(e) => { setSymbol(e.target.value) }} placeholder={kind === 'stock' ? 'PLTR' : 'ACME ROBOTICS'} /></label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">Dollars paid<input className="input mt-1" inputMode="decimal" value={cost} onChange={(e) => { setCost(e.target.value) }} placeholder="100" /></label>
          <label className="block">Shares<input className="input mt-1" inputMode="decimal" value={shares} onChange={(e) => { setShares(e.target.value) }} placeholder="4.5" /></label>
        </div>
        <label className="block">Day you bought<input className="input mt-1" type="date" value={bought} max={todayLocal()} onChange={(e) => { setBought(e.target.value) }} /></label>
        {problems.length > 0 && <ul role="alert" className="stamp space-y-1 p-3 text-sm">{problems.map((p) => <li key={p}>✕ {p}</li>)}</ul>}
        <button className="btn w-full">Check the guardrails and log it</button>
      </form>
    </Card>
  )
}

function BetRow({ bet, price, set, remove }: { bet: MoonBet; price: ReturnType<PriceOf>; set: (b: MoonBet) => void; remove: () => void }) {
  const [val, setVal] = useState('')
  const x = multiple(bet, price?.price ?? null)
  const now = bet.kind === 'private' ? (bet.value ?? null) : price ? price.price * bet.shares : null
  const gain = now === null ? null : Math.round((now - bet.cost) * 100) / 100
  const today = todayLocal()
  const lt = longTermFrom(bet.bought)
  const toLt = daysBetween(today, lt)
  const note = milestone(x)
  return (
    <li className="py-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-mono text-lg font-bold">{bet.symbol}</div>
          <div className="muted text-xs">{bet.kind === 'private' ? 'Private startup' : 'Public stock'} · {fmtShares(bet.shares)} sh · paid {fmtMoney(bet.cost)} on {fmtDay(bet.bought)}</div>
        </div>
        <div className="text-right">
          <div className="serif text-2xl" aria-label={`Worth ${fmtX(x)} what you paid`}>{fmtX(x)}</div>
          <div className={`font-mono text-sm ${gainClass(gain)}`}>{gain === null ? 'no price' : fmtSignedMoney(gain)}</div>
        </div>
      </div>
      <div className="muted mt-1 text-xs">
        {now === null ? 'No price yet.' : `Worth ${fmtMoney(now)} ${bet.kind === 'private' ? `(your estimate, ${fmtDay(bet.value_at ?? null)})` : price?.live ? '(live)' : '(last close)'}`}
        {' · '}{toLt <= 0 ? 'Long-term for taxes ✓' : `Long-term for taxes in ${String(toLt)} days (${fmtDay(lt)})`}
      </div>
      {note && <p className="mt-2 rounded-xl border border-[var(--line)] p-2 text-xs">{note}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {bet.kind === 'private' && (
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); const v = Number(val.replace(/[$,\s]/g, '')); if (v >= 0 && Number.isFinite(v)) { set({ ...bet, value: Math.round(v * 100) / 100, value_at: today }); setVal('') } }}>
            <input className="input w-32 py-1 text-xs" inputMode="decimal" placeholder="Value now $" value={val} onChange={(e) => { setVal(e.target.value) }} aria-label={`What ${bet.symbol} is worth now`} />
            <button className="btn-ghost btn px-3 py-1 text-xs">Update</button>
          </form>
        )}
        <a href={`#/sell?bet=${bet.id}`} className="btn-ghost btn px-3 py-1 text-xs">What if I sell?</a>
        <button type="button" className="btn-ghost btn px-3 py-1 text-xs" onClick={remove} aria-label={`Remove ${bet.symbol}: I sold or closed it`}>I sold it / remove</button>
      </div>
    </li>
  )
}

export function MoonBets({ m, set, planValue, closes }: { m: Moonshot; set: (m: Moonshot) => void; planValue: number; closes: Record<string, number> }) {
  const priceOf = usePrice(closes)
  if (!m.ack_at) return <div className="space-y-5"><PageHeader title="Moonshot" intro="Small, high-risk bets, kept apart from your plan." /><Checklist m={m} set={set} /></div>
  return (
    <div className="space-y-5">
      <PageHeader title="Moonshot" intro="Small, high-risk bets, kept apart from your plan, with hard limits." />
      <BudgetCard m={m} set={set} planValue={planValue} />
      <Card title="Your bets">
        {m.bets.length === 0 ? <p className="muted text-sm">No bets yet. When you make one in your broker app, log it below so the guardrails can track it.</p> : (
          <ul className="divide-y divide-[var(--line)]">
            {m.bets.map((b) => (
              <BetRow key={b.id} bet={b} price={b.kind === 'stock' ? priceOf(b.symbol) : null}
                set={(nb) => { set({ ...m, bets: m.bets.map((x) => (x.id === b.id ? nb : x)) }) }}
                remove={() => { set({ ...m, bets: m.bets.filter((x) => x.id !== b.id) }) }} />
            ))}
          </ul>
        )}
        <Explain title="What does 3.20x mean?">
          <p>It’s what the bet is worth now divided by what you paid: 1x is even, 2x is double, 16x turns $100 into $1,600, and 0.5x means half is gone.</p>
          <p>Public stocks use live prices (with your key) or the last close. Private startups have no market price, so you type in a value when the company tells you one (like a new funding round). Treat that as a guess: you usually can’t sell private shares when you want.</p>
        </Explain>
      </Card>
      <AddBet m={m} set={set} planValue={planValue} />
    </div>
  )
}

export function SellTaxes({ m, closes }: { m: Moonshot; closes: Record<string, number> }) {
  const priceOf = usePrice(closes)
  const fromHash = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('bet')
  const [betId, setBetId] = useState<string>(fromHash && m.bets.some((b) => b.id === fromHash) ? fromHash : m.bets[0]?.id ?? '')
  const bet = m.bets.find((b) => b.id === betId)
  const [status, setStatus] = useState<FilingStatus>('single')
  const [income, setIncome] = useState('60000')
  const [sellShares, setSellShares] = useState('')
  const [price, setPrice] = useState('')
  const p = bet ? (bet.kind === 'private' ? (bet.value && bet.shares ? { price: bet.value / bet.shares, live: false } : null) : priceOf(bet.symbol)) : null
  const n = sellShares === '' ? (bet?.shares ?? 0) : Number(sellShares)
  const px = price === '' ? (p?.price ?? 0) : Number(price.replace(/[$,\s]/g, ''))
  const inc = Number(income.replace(/[$,\s]/g, ''))
  const valid = bet !== undefined && n > 0 && n <= bet.shares + 1e-9 && px > 0 && inc >= 0 && Number.isFinite(inc)
  const est = valid
    ? estimateSale({ status, income: inc, proceeds: n * px, basis: (bet.cost * n) / bet.shares, bought: bet.bought, sold: todayLocal() })
    : null
  const recover = bet && px > 0 ? sharesToRecoverCost(bet.shares, bet.cost / bet.shares, px) : null
  return (
    <div className="space-y-5">
      <PageHeader title="Sell & taxes" intro="What selling does, and roughly what you’d owe, before you tap Sell." />
      {m.bets.length === 0 ? <Card><p className="text-sm">Log a bet on the Bets tab first, then come back to see what selling it would mean.</p></Card> : (
        <Card>
          <label className="block text-sm">Which bet
            <select className="input mt-1" value={betId} onChange={(e) => { setBetId(e.target.value); setSellShares(''); setPrice('') }}>
              {m.bets.map((b) => <option key={b.id} value={b.id}>{b.symbol} · {fmtShares(b.shares)} sh · bought {fmtDay(b.bought)}</option>)}
            </select>
          </label>
          <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
            <label className="block">Shares to sell<input className="input mt-1" inputMode="decimal" placeholder={bet ? String(bet.shares) : ''} value={sellShares} onChange={(e) => { setSellShares(e.target.value) }} /></label>
            <label className="block">Price per share<input className="input mt-1" inputMode="decimal" placeholder={p ? p.price.toFixed(2) : 'type it'} value={price} onChange={(e) => { setPrice(e.target.value) }} /></label>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
            <label className="block">You file as
              <select className="input mt-1" value={status} onChange={(e) => { setStatus(e.target.value as FilingStatus) }}>
                {(Object.keys(FILING_WORDS) as FilingStatus[]).map((s) => <option key={s} value={s}>{FILING_WORDS[s]}</option>)}
              </select>
            </label>
            <label className="block">Yearly income before tax<input className="input mt-1" inputMode="decimal" value={income} onChange={(e) => { setIncome(e.target.value) }} aria-label="Your yearly income before taxes, not counting this sale" /></label>
          </div>
          {p && <p className="muted mt-2 text-xs">Price filled in from {bet?.kind === 'private' ? 'your last value' : p.live ? 'the live price' : 'the last close'}. Change it to try “what if”.</p>}
          {!valid && <p className="mt-3 text-sm">Type the shares (no more than you have), a price, and your income to see the estimate.</p>}
          {est && bet && (
            <div className="mt-5 space-y-3">
              <dl className="grid grid-cols-2 gap-3 text-sm">
                <div><dt className="eyebrow">You’d get</dt><dd className="font-mono text-lg">{fmtMoney(n * px)}</dd></div>
                <div><dt className="eyebrow">{est.gain >= 0 ? 'Gain' : 'Loss'}</dt><dd className={`font-mono text-lg ${gainClass(est.gain)}`}>{fmtSignedMoney(est.gain)}</dd></div>
                <div><dt className="eyebrow">Kind</dt><dd>{est.longTerm ? 'Long-term (held over a year)' : `Short-term (held ${String(est.daysHeld)} days)`}</dd></div>
                <div><dt className="eyebrow">Est. federal tax</dt><dd className="font-mono text-lg">{est.federalTax >= 0 ? fmtMoney(est.federalTax) : `saves ${fmtMoney(-est.federalTax)}`}</dd></div>
              </dl>
              {est.gain > 0 && <p className="text-sm">About <b>{fmtPct(est.rate * 100, 0)}</b> of the gain goes to federal tax{est.niit > 0 ? ` (including ${fmtMoney(est.niit)} of the 3.8% investment-income tax)` : ''}. You’d keep about <b>{fmtMoney(est.keep)}</b> of the {fmtMoney(n * px)}, before any state tax.</p>}
              {est.ifLongTerm !== null && est.ifLongTerm < est.federalTax && (
                <p className="rounded-xl border border-[var(--color-brand-2)] p-3 text-sm">If you waited until <b>{fmtDay(est.longTermFrom)}</b> (long-term), the same gain would cost about <b>{fmtMoney(est.ifLongTerm)}</b>: <b>{fmtMoney(est.federalTax - est.ifLongTerm)}</b> less. The price could fall while you wait; that’s the trade-off.</p>
              )}
              {est.gain < 0 && <p className="text-sm">A loss lowers your tax: it cancels out other gains first, then up to {fmtMoney(LOSS_LIMIT, false)} a year of your regular income.{est.carryForward > 0 ? ` The other ${fmtMoney(est.carryForward)} carries forward to next year.` : ''} Don’t buy it back within 30 days, or the loss doesn’t count (the “wash sale” rule).</p>}
              {recover !== null && <p className="text-sm">To take just your original {fmtMoney(bet.cost)} back out, you’d sell about <b>{fmtShares(recover)}</b> of your {fmtShares(bet.shares)} shares at this price, leaving the rest in.</p>}
              <p className="muted text-xs">Estimate only, not tax advice: federal tax for {String(TAX_YEAR)} using {TAX_SOURCE}, the standard deduction, and this sale as your only gain or loss. State tax is extra in most states. For a big gain, ask a tax pro.</p>
            </div>
          )}
        </Card>
      )}
      <SellingExplained />
    </div>
  )
}

function SellingExplained() {
  return (
    <Card title="What selling actually does">
      <ul className="space-y-3 text-sm">
        <li><b>You lock in the result.</b> Before you sell, a gain or loss is only on paper (“unrealized”). Selling makes it real (“realized”), and that’s when tax comes in.</li>
        <li><b>The cash arrives the next business day.</b> US stock trades settle in one business day. In Robinhood the money shows up as buying power; moving it to your bank is a separate step.</li>
        <li><b>Tax is owed even if the cash stays in your account.</b> Selling for a gain is taxable in that calendar year whether or not you withdraw it or buy something else.</li>
        <li><b>Your broker reports it.</b> Early the next year Robinhood sends a Form 1099-B listing every sale. You report it on Form 8949 and Schedule D with your tax return.</li>
        <li><b>A big gain can mean paying during the year.</b> Taxes aren’t withheld from stock sales. If you owe a lot, the IRS expects quarterly “estimated tax” payments, or you may owe a penalty.</li>
        <li><b>Selling part is allowed.</b> You can sell some shares and keep the rest. Many people sell enough to get their original money back after a big run-up.</li>
      </ul>
    </Card>
  )
}

export function MoonLearn() {
  const t = TABLES.single
  return (
    <div className="space-y-5">
      <PageHeader title="Learn the risk" intro="How big swings really work, what startups involve, and how stock taxes work." />
      <Card title="Why 16x in a month is so rare">
        <div className="space-y-2 text-sm">
          <p>Stocks that jump 10x+ in weeks are almost always tiny companies, brand-new listings, or hype. The same stocks often fall 80–90% just as fast, and you only hear about the winners (“survivorship bias”).</p>
          <p>Before chasing one, ask: who is selling to me, and why? Tiny stocks can be pushed up on social media and then sold by the people who hyped them (“pump and dump”).</p>
          <p>The math of losses is harsh: after a 50% drop you need a 100% gain just to get back to even. That’s why the budget limits each bet.</p>
        </div>
      </Card>
      <Card title="Investing in startups (private companies)">
        <div className="space-y-2 text-sm">
          <p><b>You usually can’t buy them in Robinhood.</b> Private companies aren’t on the stock market. Regular investors can buy small stakes through SEC-registered crowdfunding sites, which cap how much non-wealthy people can invest each year.</p>
          <p><b>You can’t sell when you want.</b> Crowdfunded shares generally can’t be resold for a year, and often there’s no buyer for many years, until the company is bought or goes public. Plan on this money being stuck.</p>
          <p><b>Most startups fail.</b> Startup investors expect most bets to return nothing, hoping one big winner pays for the rest. That only works with many small bets, not one big one.</p>
          <p>Bigger private deals are mostly limited to “accredited investors” (roughly $200,000+ income for two years, $300,000 with a spouse, or $1 million net worth not counting your home).</p>
        </div>
      </Card>
      <Card title={`How stock taxes work (${String(TAX_YEAR)})`}>
        <div className="space-y-2 text-sm">
          <p><b>Short-term</b> (held one year or less): the gain is taxed like your paycheck, at your regular rate (10% to 37%).</p>
          <p><b>Long-term</b> (held more than one year): lower rates of 0%, 15% or 20%. For a single filer in {String(TAX_YEAR)}, gains are 0% while your taxable income stays under {fmtMoney(t.zeroUpTo, false)}, and 15% up to {fmtMoney(t.fifteenUpTo, false)}.</p>
          <p><b>High earners</b> pay an extra 3.8% on investment gains above about {fmtMoney(t.niitOver, false)} of income ({fmtMoney(TABLES.mfj.niitOver, false)} married filing jointly).</p>
          <p><b>Losses help.</b> Losses cancel out gains, then up to {fmtMoney(LOSS_LIMIT, false)} a year of regular income; the rest rolls forward. Buying the same stock back within 30 days before or after (a “wash sale”) cancels the loss for now.</p>
          <p><b>A Roth IRA changes everything.</b> Gains inside a Roth IRA aren’t taxed when you sell, and qualified withdrawals in retirement are tax-free. There are yearly limits on what you can put in.</p>
          <p><b>States tax gains too</b>, in most states, as regular income.</p>
          <p className="muted text-xs">Numbers: <a className="underline" href={TAX_SOURCE_URL} target="_blank" rel="noreferrer noopener">{TAX_SOURCE}</a>. This is education, not tax advice.</p>
        </div>
      </Card>
      <Card title="The guardrails, and why">
        <ul className="space-y-2 text-sm">
          <li><b>A budget of 1–{String(MAX_BUDGET_PCT)}% of everything.</b> Even losing it all leaves your plan intact.</li>
          <li><b>No bet over {String(MAX_BET_SHARE * 100)}% of the budget.</b> One blow-up can’t wipe out the rest.</li>
          <li><b>Bets count at what you paid.</b> A winning streak doesn’t raise your limit.</li>
          <li><b>No borrowing.</b> This side doesn’t track margin or options: with borrowed money you can lose more than you put in.</li>
          <li><b>The plan stays separate.</b> Nothing here changes the Steady side’s buy days or amounts.</li>
        </ul>
      </Card>
    </div>
  )
}

function RadarList({ rows, empty }: { rows: RadarRow[]; empty: string }) {
  if (rows.length === 0) return <p className="muted text-sm">{empty}</p>
  return (
    <ul className="divide-y divide-[var(--line)]">
      {rows.map(({ c, why }) => (
        <li key={c.s}>
          <a href={`#/search?s=${encodeURIComponent(c.s)}`} className="block py-3">
            <div className="flex items-center justify-between gap-3">
              <span className="font-mono font-bold">{c.s}</span>
              <VerdictBadge v={c.v} />
            </div>
            <div className="muted truncate text-xs">{c.n} · {fmtBig(c.rev)} a year in sales</div>
            <div className="mt-1 text-sm">{why}.</div>
          </a>
        </li>
      ))}
    </ul>
  )
}

export function Radar({ research, error }: { research: Research | null; error: string | null }) {
  const rising = research ? underTheRadar(research.companies) : []
  const fading = research ? warningSigns(research.companies) : []
  const [dossier, setDossier] = useState<Dossier | null>(null)
  const [dErr, setDErr] = useState<string | null>(null)
  useEffect(() => {
    let off = false
    fetchDossier().then((d) => { if (!off) setDossier(d) }, (e: unknown) => { if (!off) setDErr(e instanceof Error ? e.message : 'Insider data isn’t available.') })
    return () => { off = true }
  }, [])
  const buying = research && dossier ? insidersBuying(research.companies, dossier) : []
  return (
    <div className="space-y-5">
      <PageHeader title="Radar" intro="Lesser-known companies on the rise, and famous ones showing cracks, straight from their reports." />
      {error && <Card><p className="text-sm">{error}</p></Card>}
      {!research && !error && <p className="muted">Loading the company list…</p>}
      {research && (
        <>
          <Card title="Under the radar">
            <p className="muted mb-2 text-xs">Companies with under {fmtBig(SMALL_MAX)} in yearly sales whose sales grew over {String(FAST_GROWTH)}% a year, and whose profits are improving or that already make cash. Fastest first.</p>
            <RadarList rows={rising} empty="None match today." />
          </Card>
          <Card title="Insiders buying">
            <p className="muted mb-2 text-xs">Executives and directors who bought their own company’s stock on the open market in the last {String(dossier?.window_days ?? 90)} days: several at once first, then over {fmtMoney(INSIDER_MIN, false)}. From SEC Form 4 filings.</p>
            {dErr ? <p className="muted text-sm">{dErr}</p> : !dossier ? <p className="muted text-sm">Loading insider filings…</p> : <RadarList rows={buying} empty={`None yet in the ${String(dossier.days.length)} filing days read so far.`} />}
          </Card>
          <Card title="Warning signs">
            <p className="muted mb-2 text-xs">Household names (over {fmtBig(BIG_MIN)} in sales) whose sales shrank last year, or whose profit per $1 of sales fell by {String(MARGIN_DROP)}¢ or more in two years.</p>
            <RadarList rows={fading} empty="None today." />
          </Card>
        </>
      )}
      <Card>
        <Explain title="How should I use the radar?">
          <p><b>It shows facts, not predictions.</b> Every number comes from the company’s own yearly SEC report, updated each evening. A fast grower can still be a terrible stock if its price already assumes years of growth, and a slipping giant can recover.</p>
          <p><b>Under the radar</b> is where big long-term winners often start: small, growing fast, and getting more profitable. Most still won’t make it, and small stocks swing hard. That’s what the Moonshot budget is for.</p>
          <p><b>Warning signs</b> are the clues that are public before most people notice: sales that stop growing and a shrinking profit per $1 of sales, like the slowdown you saw at Nike. If you own one, it’s a reason to look closer, not an order to sell.</p>
          <p>Tap any company to see its full check-up in Search. Reports come out once a year, so the radar changes slowly.</p>
        </Explain>
      </Card>
    </div>
  )
}

import { api, type Dashboard, type Mood } from '../api'
import { Card, ErrorText, Explain, PageHeader, StaleBanner } from '../components/ui'
import { fmtMoney, fmtSignedMoney, fmtSignedPct, gainClass } from '../format'
import { useApi } from '../useApi'

const MOOD_STYLE: Record<Mood, { emoji: string; label: string; ring: string }> = {
  green: { emoji: '🟢', label: 'Green', ring: 'border-[var(--color-up)]' },
  yellow: { emoji: '🟡', label: 'Yellow', ring: 'border-[var(--color-warn)]' },
  red: { emoji: '🔴', label: 'Red', ring: 'border-[var(--color-down)]' },
  unknown: { emoji: '⚪', label: 'Not enough data yet', ring: 'border-[var(--line)]' },
}

export function MoodCard({ d }: { d: Dashboard }) {
  const s = MOOD_STYLE[d.mood.mood]
  return (
    <Card className={`border-2 ${s.ring}`}>
      <div className="muted text-xs font-semibold uppercase tracking-wider">Market mood today</div>
      <div className="mt-2 flex items-center gap-3">
        <span className="text-4xl" aria-hidden>
          {s.emoji}
        </span>
        <span className="text-3xl font-bold">{s.label}</span>
      </div>
      <p className="mt-3 text-lg">{d.mood.headline}</p>
      <ul className="mt-3 space-y-1 text-sm">
        {d.mood.reasons.map((r) => (
          <li key={r}>• {r}</li>
        ))}
      </ul>
      <Explain>
        <p>
          This is a <b>weather report</b> for the stock market, not a buy or sell signal. It checks two things:
        </p>
        <p>
          <b>1. Which way is the market heading?</b> The <b>S&amp;P 500</b> is the 500 biggest US companies and is
          used as the market’s scoreboard. We compare today’s level with its average over the last ~10 months
          (the “200-day average”). Above the average means it has been trending up; below means trending down.
        </p>
        <p>
          <b>2. How nervous are investors?</b> The <b>VIX</b>, nicknamed the “fear gauge”, is one number that measures
          how wildly investors expect prices to swing soon. Under 20 is calm, 20–30 is nervous, over 30 is scared
          (it went far above 30 in 2008 and in March 2020).
        </p>
        <p>
          🟢 = going up and calm. 🔴 = going down and scared. 🟡 = anything in between.{' '}
          <b>For a long-term investor the right move is usually the same in every color: keep adding money on schedule.</b>{' '}
          The color is here so scary headlines don’t surprise you.
        </p>
      </Explain>
    </Card>
  )
}

export function PortfolioCard({ d }: { d: Dashboard }) {
  const p = d.portfolio
  if (p.positions.length === 0) {
    return (
      <Card title="Your money">
        <p>You haven’t told the app what you own yet.</p>
        <p className="muted mt-2 text-sm">
          Go to <a className="underline" href="#/money">My Money</a> and type in each investment (for example “10 shares of
          VTI that I paid $250 each for”). Then this card shows how you’re doing.
        </p>
      </Card>
    )
  }
  return (
    <Card title="Your money">
      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <div className="muted text-xs font-semibold uppercase tracking-wider">Worth today</div>
          <div className="mt-1 font-mono text-3xl font-bold">{fmtMoney(p.value)}</div>
        </div>
        <div>
          <div className="muted text-xs font-semibold uppercase tracking-wider">Change today</div>
          <div className={`mt-1 font-mono text-2xl font-bold ${gainClass(p.day_change)}`}>
            {fmtSignedMoney(p.day_change)}
          </div>
          <div className={`text-sm ${gainClass(p.day_change)}`}>{fmtSignedPct(p.day_change_pct)}</div>
        </div>
        <div>
          <div className="muted text-xs font-semibold uppercase tracking-wider">Total gain or loss</div>
          <div className={`mt-1 font-mono text-2xl font-bold ${gainClass(p.total_change)}`}>
            {fmtSignedMoney(p.total_change)}
          </div>
          <div className={`text-sm ${gainClass(p.total_change)}`}>
            {fmtSignedPct(p.total_change_pct)} since you bought (you paid {fmtMoney(p.cost_basis)})
          </div>
        </div>
      </div>
      {p.missing_prices.length > 0 && (
        <p className="mt-3 text-sm text-[var(--color-warn)]">
          ⚠️ No price yet for {p.missing_prices.join(', ')}, so it isn’t counted above. Click “Refresh prices”.
        </p>
      )}
      <Explain>
        <p>
          <b>Worth today</b> is what everything you own would sell for at the latest closing price (prices update after
          the market closes at 4 p.m. Eastern on weekdays).
        </p>
        <p>
          <b>Change today</b> is how much that went up or down since the day before. Daily ups and downs are normal; a
          long-term investor can mostly ignore them.
        </p>
        <p>
          <b>Total gain or loss</b> compares today’s worth with what you paid. Green means you’re ahead, red means behind.
          You only actually gain or lose when you sell.
        </p>
      </Explain>
    </Card>
  )
}

export function Home() {
  const { data, error, loading, busy, run } = useApi(api.dashboard)
  return (
    <div>
      <PageHeader
        title="Home"
        intro="Your one-glance check-in: how the market feels today and how your money is doing."
        action={
          <button className="btn" disabled={busy || loading} onClick={() => void run(api.refreshMarket)}>
            {busy ? 'Getting latest prices…' : 'Refresh prices'}
          </button>
        }
      />
      {error && <ErrorText>{error}</ErrorText>}
      {loading && <p className="muted">Loading…</p>}
      {data && (
        <div className="space-y-6">
          <StaleBanner
            items={[
              { label: 'S&P 500', f: data.index_freshness },
              { label: 'VIX (fear gauge)', f: data.vix_freshness },
              ...Object.entries(data.holdings_freshness).map(([sym, f]) => ({ label: sym, f })),
            ]}
          />
          <MoodCard d={data} />
          <PortfolioCard d={data} />
        </div>
      )}
    </div>
  )
}

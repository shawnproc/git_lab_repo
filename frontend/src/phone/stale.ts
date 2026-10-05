// "Never show stale data as current." How many market days old are the prices? Pure.
// The snapshot publishes recent and upcoming market days with their real closing times, so this
// counts holidays and early closes correctly without any guessing on the phone.

export interface Session { day: string; close: string } // close: ISO time (UTC)

export interface RefreshStatus {
  ok: boolean
  checked_at: string
  published_generated_at: string | null
  kept_previous: boolean
  errors: string[]
}

export interface Freshness {
  stale: boolean
  behind: number | null // market days completed since the prices' date
  price_day: string | null
  reason: string
}

const MAX_BEHIND = 1 // more than one completed market day behind = stale

/** `priceDays`: the price date of each plan holding (the oldest one counts). */
export function freshness(priceDays: (string | null | undefined)[], sessions: Session[] | undefined, status: RefreshStatus | null, now: Date): Freshness {
  const days = priceDays.filter((d): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d))
  if (status && !status.ok) {
    const what = status.errors[0] ?? 'the update didn’t pass its checks'
    return { stale: true, behind: null, price_day: days.sort()[0] ?? null, reason: `Today’s update failed its safety checks (${what}), so these are older prices.` }
  }
  if (days.length === 0) return { stale: true, behind: null, price_day: null, reason: 'There are no prices yet.' }
  const oldest = days.sort()[0] ?? ''
  if (!sessions || sessions.length === 0) {
    return { stale: true, behind: null, price_day: oldest, reason: 'This data file is too old to check how current it is.' }
  }
  const t = now.getTime()
  const lastClose = Date.parse(sessions[sessions.length - 1]?.close ?? '')
  if (!Number.isFinite(lastClose) || t > lastClose) {
    return { stale: true, behind: null, price_day: oldest, reason: 'These prices are weeks old.' }
  }
  const behind = sessions.filter((s) => s.day > oldest && Date.parse(s.close) <= t).length
  if (behind > MAX_BEHIND) {
    return { stale: true, behind, price_day: oldest, reason: `Prices are ${String(behind)} market days old; the daily update hasn’t run.` }
  }
  return { stale: false, behind, price_day: oldest, reason: '' }
}

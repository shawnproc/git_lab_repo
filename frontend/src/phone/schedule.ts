// Your buy schedule: which days are buy days, and whether this period's buy is done.
// Pure functions on "YYYY-MM-DD" dates (your phone's local calendar). No clock reads.
// A schedule, not a market signal: buying on a steady rhythm beats guessing the "right" day.

export const CADENCES = ['weekly', 'biweekly', 'semimonthly', 'monthly'] as const
export type Cadence = (typeof CADENCES)[number]

export interface Schedule {
  cadence: Cadence
  amount: number // dollars each buy day
  anchor: string // a first buy day; sets the weekday for weekly / every-2-weeks
}

export const CADENCE_WORDS: Record<Cadence, string> = {
  weekly: 'Every week',
  biweekly: 'Every 2 weeks',
  semimonthly: 'Twice a month (1st and 15th)',
  monthly: 'Once a month (1st)',
}

export const defaultSchedule = (today: string): Schedule => ({ cadence: 'semimonthly', amount: 75, anchor: today })

const toUtc = (day: string) => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)))
const fromUtc = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const addDays = (day: string, n: number) => fromUtc(toUtc(day) + n * 86_400_000)
const daysBetween = (a: string, b: string) => Math.round((toUtc(b) - toUtc(a)) / 86_400_000)

/** The buy day that starts the period `today` is in. */
export function periodStart(today: string, s: Schedule): string {
  const ym = today.slice(0, 7)
  switch (s.cadence) {
    case 'monthly': return `${ym}-01`
    case 'semimonthly': return Number(today.slice(8, 10)) >= 15 ? `${ym}-15` : `${ym}-01`
    case 'weekly':
    case 'biweekly': {
      const step = s.cadence === 'weekly' ? 7 : 14
      const k = Math.floor(daysBetween(s.anchor, today) / step)
      return addDays(s.anchor, k * step)
    }
  }
}

/** The next buy day after the current period's. */
export function nextStart(today: string, s: Schedule): string {
  const start = periodStart(today, s)
  switch (s.cadence) {
    case 'weekly': return addDays(start, 7)
    case 'biweekly': return addDays(start, 14)
    case 'semimonthly':
      if (start.endsWith('-01')) return `${start.slice(0, 7)}-15`
      return nextMonth(start)
    case 'monthly': return nextMonth(start)
  }
}

function nextMonth(day: string): string {
  const y = Number(day.slice(0, 4))
  const m = Number(day.slice(5, 7))
  return m === 12 ? `${String(y + 1)}-01-01` : `${String(y)}-${String(m + 1).padStart(2, '0')}-01`
}

export interface BuyStatus {
  due: boolean // no buy logged since this period's buy day
  since: string // this period's buy day
  next: string // the next buy day
  days_to_next: number
}

/** `buys` are the local days you logged a buy (stones you laid yourself). */
export function buyStatus(today: string, s: Schedule, buys: string[]): BuyStatus {
  const since = periodStart(today, s)
  const next = nextStart(today, s)
  const due = !buys.some((d) => d >= since && d <= today)
  return { due, since, next, days_to_next: daysBetween(today, next) }
}

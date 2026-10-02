const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

export function fmtNumber(n: number | null, digits = 2): string {
  if (n === null || !Number.isFinite(n)) return '—'
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

export function fmtMoney(n: number | null, cents = true): string {
  if (n === null || !Number.isFinite(n)) return '—'
  return (cents ? usd : usd0).format(n)
}

export function fmtSignedMoney(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—'
  return (n > 0 ? '+' : n < 0 ? '−' : '') + usd.format(Math.abs(n))
}

export function fmtPct(n: number | null, digits = 1): string {
  if (n === null || !Number.isFinite(n)) return '—'
  return `${n.toFixed(digits)}%`
}

export function fmtSignedPct(n: number | null, digits = 2): string {
  if (n === null || !Number.isFinite(n)) return '—'
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(digits)}%`
}

export function fmtShares(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—'
  return n.toLocaleString('en-US', { maximumFractionDigits: 4 })
}

export function fmtTimestamp(iso: string | null): string {
  if (!iso) return 'never'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'invalid time'
  return (
    d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/New_York' }) +
    ' ET'
  )
}

export function fmtDay(day: string | null): string {
  if (!day) return '—'
  const d = new Date(`${day}T12:00:00Z`)
  if (Number.isNaN(d.getTime())) return day
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

export function gainClass(n: number | null): string {
  if (n === null || n === 0) return ''
  return n > 0 ? 'text-[var(--color-up)]' : 'text-[var(--color-down)]'
}

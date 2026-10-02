import type { Course, Stone, Wall } from '../api'
import { fmtMoney } from '../format'

const INITIAL = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D']

function stoneLabel(s: Stone): string {
  switch (s.state) {
    case 'laid':
      return `${s.label}: ${fmtMoney(s.amount)} invested${s.entries > 1 ? ` (${String(s.entries)} entries)` : ''}`
    case 'open':
      return `${s.label}: not laid yet (this month)`
    case 'missed':
      return `${s.label}: no investment logged`
    case 'future':
      return `${s.label}: still to come`
    case 'before_start':
      return `${s.label}: before your first stone`
  }
}

function StoneBlock({ s, latest, index, offset }: { s: Stone; latest: boolean; index: number; offset: boolean }) {
  const base = 'flex h-9 items-center justify-center rounded-[2px] font-mono text-[0.65rem] font-semibold select-none'
  const col = { gridColumn: `${String(index * 2 + (offset ? 2 : 1))} / span 2` }
  const label = stoneLabel(s)
  if (s.state === 'laid') {
    return (
      <div role="listitem" aria-label={label} title={label} className={base} style={{
        ...col,
        color: latest ? '#1a1206' : '#ffffff',
        background: latest
          ? 'linear-gradient(160deg, var(--stone-pick-2), var(--stone-pick))'
          : `linear-gradient(160deg, ${index % 2 ? 'var(--stone-core-2)' : 'var(--stone-core)'}, var(--stone-core))`,
        boxShadow: 'inset 0 -3px 0 rgb(0 0 0 / 0.25), inset 0 2px 0 rgb(255 255 255 / 0.18)',
      }}>
        {INITIAL[index]}
      </div>
    )
  }
  const style: Record<string, string> = {
    open: 'border-2 border-dashed border-[var(--color-brand-2)] text-[var(--color-brand-2)]',
    missed: 'border border-dashed border-[var(--muted)] text-[var(--muted)] opacity-70',
    future: 'border border-dotted border-[var(--line)] text-[var(--line)] opacity-50',
    before_start: 'opacity-0',
  }
  return (
    <div role="listitem" aria-label={label} title={label} className={`${base} ${style[s.state] ?? ''}`} style={col}>
      {s.state === 'open' ? '?' : s.state === 'before_start' ? '' : INITIAL[index]}
    </div>
  )
}

function KeystoneBadge({ earned, year }: { earned: boolean; year: number }) {
  const label = earned ? `${String(year)}: all 12 months laid, keystone earned` : `${String(year)}: keystone not earned yet`
  return (
    <svg width="26" height="30" viewBox="0 0 26 30" role="img" aria-label={label} className="shrink-0">
      <title>{label}</title>
      <path d="M1 2 H25 L20 28 H6 Z" fill={earned ? 'var(--color-brand-2)' : 'none'}
        stroke={earned ? 'var(--color-brand-2)' : 'var(--line)'} strokeWidth="1.5" strokeDasharray={earned ? undefined : '3 2'} />
      {earned && <path d="M8 14 l3.5 3.5 L18 10" fill="none" stroke="var(--panel)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  )
}

/**
 * The wall: one row (course) per year, newest on top so it grows upward from your first year.
 * Rows alternate by half a stone (running bond), like real brickwork.
 */
export function GrowingWall({ wall, maxYears }: { wall: Wall; maxYears?: number }) {
  const courses: Course[] = maxYears ? wall.courses.slice(0, maxYears) : wall.courses
  const hidden = wall.courses.length - courses.length
  // Latest laid stone (highlighted in brass).
  const latest = wall.courses.flatMap((c) => c.stones).filter((s) => s.state === 'laid').map((s) => s.month).sort().pop()
  return (
    <div>
      <div role="list" aria-label="Your wall: one stone per month you invested" className="space-y-[3px]">
        {courses.map((c) => {
          // Offset alternate rows counted from the bottom (the foundation never moves).
          const fromBottom = wall.courses.length - 1 - wall.courses.indexOf(c)
          const offset = fromBottom % 2 === 1
          return (
            <div key={c.year} role="listitem" aria-label={`${String(c.year)}: ${String(c.laid)} of 12 months laid`} className="flex items-center gap-2">
              <span className="w-11 shrink-0 text-right font-mono text-xs muted">{c.year}</span>
              <div role="list" className="grid flex-1 gap-[3px]" style={{ gridTemplateColumns: 'repeat(25, minmax(0, 1fr))' }}>
                {c.stones.map((s, i) => (
                  <StoneBlock key={s.month} s={s} index={i} offset={offset} latest={s.month === latest} />
                ))}
              </div>
              <KeystoneBadge earned={c.keystone} year={c.year} />
            </div>
          )
        })}
      </div>
      <div className="ml-[3.25rem] mr-[2.1rem] mt-[3px] h-2 rounded-[1px] bg-[var(--line)]" aria-hidden />
      {hidden > 0 && <p className="muted mt-2 text-xs">+ {hidden} earlier year(s) below. See all on My Money.</p>}
      <div className="muted mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <span><span aria-hidden className="mr-1 inline-block h-3 w-4 rounded-[1px] bg-[var(--stone-core)] align-middle" />Stone laid</span>
        <span><span aria-hidden className="mr-1 inline-block h-3 w-4 rounded-[1px] bg-[var(--stone-pick)] align-middle" />Latest stone</span>
        <span><span aria-hidden className="mr-1 inline-block h-3 w-4 rounded-[1px] border-2 border-dashed border-[var(--color-brand-2)] align-middle" />This month, not laid yet</span>
        <span><span aria-hidden className="mr-1 inline-block h-3 w-4 rounded-[1px] border border-dashed border-[var(--muted)] align-middle" />No investment logged</span>
      </div>
    </div>
  )
}

export function WallStats({ wall }: { wall: Wall }) {
  const items = [
    { label: 'Stones laid', value: String(wall.months_laid), sub: 'months you invested' },
    { label: 'Current streak', value: String(wall.current_streak), sub: 'months in a row' },
    { label: 'Best streak', value: String(wall.longest_streak), sub: 'months in a row' },
    { label: 'Total you logged', value: fmtMoney(wall.total, false), sub: 'what you typed in' },
  ]
  return (
    <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
      {items.map((i) => (
        <div key={i.label}>
          <dt className="eyebrow">{i.label}</dt>
          <dd className="mt-1 font-mono text-2xl font-semibold">{i.value}</dd>
          <dd className="muted text-xs">{i.sub}</dd>
        </div>
      ))}
    </dl>
  )
}

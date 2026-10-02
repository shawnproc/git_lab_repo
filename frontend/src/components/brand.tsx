import type { Mood, TargetRow } from '../api'
import { fmtPct } from '../format'

/** Logo: a round arch of stones with the brass keystone at the top. */
export function KeystoneLogo({ size = 36 }: { size?: number }) {
  const stones = archStones(7, 20, 9, 18, 30, 5)
  return (
    <svg width={size} height={size} viewBox="0 0 40 34" aria-hidden="true">
      {stones.map((d, i) => (
        <path key={i} d={d} fill={i === 3 ? 'var(--color-brand-2)' : 'var(--color-brand)'} opacity={i === 3 ? 1 : 0.85} />
      ))}
      <rect x="2" y="30" width="36" height="3" fill="var(--color-brand)" />
    </svg>
  )
}

/** Paths for `n` voussoirs of a semicircular arch (center cx, base y, inner r1, outer r2). */
function archStones(n: number, cx: number, r1: number, r2: number, baseY = 30, gapDeg = 3): string[] {
  const out: string[] = []
  const step = 180 / n
  for (let i = 0; i < n; i++) {
    const a0 = ((180 - i * step - gapDeg / 2) * Math.PI) / 180
    const a1 = ((180 - (i + 1) * step + gapDeg / 2) * Math.PI) / 180
    const p = (r: number, a: number) => `${(cx + r * Math.cos(a)).toFixed(2)} ${(baseY - r * Math.sin(a)).toFixed(2)}`
    out.push(`M ${p(r1, a0)} L ${p(r2, a0)} A ${String(r2)} ${String(r2)} 0 0 1 ${p(r2, a1)} L ${p(r1, a1)} A ${String(r1)} ${String(r1)} 0 0 0 ${p(r1, a0)} Z`)
  }
  return out
}

const ZONES: { mood: Exclude<Mood, 'unknown'>; label: string; color: string }[] = [
  { mood: 'red', label: 'Falling and fearful', color: 'var(--color-down)' },
  { mood: 'yellow', label: 'Mixed signals', color: 'var(--color-warn)' },
  { mood: 'green', label: 'Calm and rising', color: 'var(--color-up)' },
]

/**
 * Market mood as an arch of 9 stones: left third red, middle third yellow (holding the keystone),
 * right third green. The current zone is lit; the others fade back. It's 3 states, so there is no
 * needle: we never imply more precision than the rule has.
 */
export function MoodArch({ mood }: { mood: Mood }) {
  const stones = archStones(9, 120, 62, 104, 116, 2.4)
  return (
    <figure className="m-0">
      <svg viewBox="0 0 240 124" className="w-full max-w-[22rem]" role="img"
        aria-label={mood === 'unknown' ? 'Market mood: not enough data yet' : `Market mood: ${mood}`}>
        {stones.map((d, i) => {
          const zone = ZONES[Math.floor(i / 3)] ?? ZONES[0]
          const lit = zone?.mood === mood
          const isKey = i === 4
          return (
            <path key={i} d={d}
              fill={mood === 'unknown' ? 'transparent' : (zone?.color ?? 'currentColor')}
              fillOpacity={lit ? 1 : 0.14}
              stroke={mood === 'unknown' ? 'var(--muted)' : lit ? 'var(--panel)' : (zone?.color ?? 'currentColor')}
              strokeOpacity={lit || mood === 'unknown' ? 1 : 0.55}
              strokeDasharray={mood === 'unknown' ? '4 3' : undefined}
              strokeWidth={isKey ? 3 : 2} />
          )
        })}
        <rect x="8" y="116" width="224" height="6" fill="var(--line)" />
      </svg>
      <figcaption className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {ZONES.map((z) => (
          <span key={z.mood} className={z.mood === mood ? 'font-bold' : 'muted'}>
            <span aria-hidden style={{ color: z.color }}>■</span> {z.label}
            {z.mood === mood && ' ← today'}
          </span>
        ))}
      </figcaption>
    </figure>
  )
}

/**
 * The plan as a masonry wall: the bottom course is your foundation (core funds), the top course
 * the hand-picked companies. Block widths are proportional to each target within its course;
 * the course height is proportional to the course's share of the whole plan.
 */
export function FoundationWall({ targets }: { targets: TargetRow[] }) {
  const courses = [
    { kind: 'stock' as const, title: 'Hand-picked companies', fill: 'var(--stone-pick)', fill2: 'var(--stone-pick-2)', ink: '#1a1206' },
    { kind: 'core' as const, title: 'Safe foundation (core)', fill: 'var(--stone-core)', fill2: 'var(--stone-core-2)', ink: '#ffffff' },
  ]
  return (
    <div className="space-y-[3px]" role="img" aria-label={targets.map((t) => `${t.symbol} ${fmtPct(t.target_pct)}`).join(', ')}>
      {courses.map((c) => {
        const blocks = targets.filter((t) => t.kind === c.kind)
        const total = blocks.reduce((a, t) => a + t.target_pct, 0)
        if (blocks.length === 0) return null
        return (
          <div key={c.kind}>
            <div className="flex gap-[3px]" style={{ height: `${String(Math.max(44, total * 1.6))}px` }}>
              {blocks.map((t, i) => (
                <div key={t.symbol} title={`${t.symbol}: ${fmtPct(t.target_pct)} of your money`}
                  className="flex min-w-0 flex-col justify-end overflow-hidden rounded-[2px] px-2 py-1"
                  style={{
                    color: c.ink,
                    flexGrow: t.target_pct,
                    flexBasis: 0,
                    background: `linear-gradient(160deg, ${i % 2 ? c.fill2 : c.fill}, ${c.fill})`,
                    boxShadow: 'inset 0 -3px 0 rgb(0 0 0 / 0.25), inset 0 2px 0 rgb(255 255 255 / 0.18)',
                  }}>
                  <span className="truncate font-mono text-sm font-semibold">{t.symbol}</span>
                  <span className="truncate font-mono text-xs opacity-90">{fmtPct(t.target_pct)}</span>
                </div>
              ))}
            </div>
            <div className="eyebrow mt-1">{c.title} · {fmtPct(total, 0)}</div>
          </div>
        )
      })}
    </div>
  )
}

/**
 * Drift as a carpenter's spirit level: the center line is your target, the bubble is where you
 * actually are, and the two ticks mark the allowed range (±5 percentage points).
 */
export function SpiritLevel({ diffPp, flagged, maxPp = 5, rangePp = 20 }: {
  diffPp: number | null
  flagged: boolean
  maxPp?: number
  rangePp?: number
}) {
  if (diffPp === null) return <span className="muted text-xs">—</span>
  const clamp = Math.max(-1, Math.min(1, diffPp / rangePp))
  const tick = (maxPp / rangePp) * 50
  const label = `${Math.abs(diffPp).toFixed(1)} points ${diffPp >= 0 ? 'above' : 'below'} target`
  return (
    <div className="relative h-5 w-32 rounded-full border-2 border-[var(--line)] bg-[color-mix(in_oklab,var(--color-up)_10%,var(--panel-2))]"
      role="img" aria-label={label} title={label}>
      <span className="absolute top-0 h-full w-px bg-[var(--text)]" style={{ left: '50%' }} />
      <span className="absolute top-0 h-full w-px bg-[var(--muted)] opacity-70" style={{ left: `${String(50 - tick)}%` }} />
      <span className="absolute top-0 h-full w-px bg-[var(--muted)] opacity-70" style={{ left: `${String(50 + tick)}%` }} />
      <span
        className="absolute top-1/2 h-3 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-black/20"
        style={{
          left: `${String(50 + clamp * 50)}%`,
          background: flagged ? 'var(--color-warn)' : 'var(--color-up)',
          boxShadow: 'inset 0 1px 1px rgb(255 255 255 / 0.6)',
        }}
      />
    </div>
  )
}

/** Check result as a stone: solid with a tick (pass), cracked (fail), dashed outline (no data). */
export function StoneIcon({ status }: { status: 'pass' | 'fail' | 'unavailable' }) {
  const label = { pass: 'Passed', fail: 'Failed', unavailable: 'No data' }[status]
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" role="img" aria-label={label} className="inline-block align-[-3px]">
      <title>{label}</title>
      {status === 'pass' && (
        <>
          <rect x="1" y="2" width="14" height="12" rx="1.5" fill="var(--color-up)" />
          <path d="M4.5 8.2 7 10.6 11.6 5.6" fill="none" stroke="var(--panel)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
      {status === 'fail' && (
        <>
          <rect x="1" y="2" width="14" height="12" rx="1.5" fill="var(--color-down)" />
          <path d="M6 2 8.5 7 6.5 9.5 9 14" fill="none" stroke="var(--panel)" strokeWidth="1.8" strokeLinejoin="round" />
        </>
      )}
      {status === 'unavailable' && (
        <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="var(--muted)" strokeWidth="1.5" strokeDasharray="2.5 2" />
      )}
    </svg>
  )
}

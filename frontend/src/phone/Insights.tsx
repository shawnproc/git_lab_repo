// Phone cards for: price freshness, the top 3 for new money, sleeve vs the index, VTI overlap,
// the funds/stocks split, company status, and passphrase-locked backups.
import { type ChangeEvent, type SubmitEvent, useState } from 'react'
import { Card, Explain } from '../components/ui'
import { fmtDay, fmtMoney, fmtPct, fmtSignedMoney, fmtTimestamp, gainClass } from '../format'
import { encryptBackup, isEncrypted, MIN_PASSPHRASE, openBackup } from './backup'
import { splitContribution } from './logic'
import { type Snapshot, type SnapTarget, skipFor, type Trend } from './model'
import { belowHigh, holdingValues } from './portfolio'
import { sleeveVsIndex } from './sleeve'
import type { Freshness } from './stale'
import { CORE_CHOICES, type PhoneData } from './store'

const BACKUP_EVERY_DAYS = 30

const TREND: Record<Trend, { mark: string; label: string }> = {
  improving: { mark: '▲', label: 'Getting stronger' },
  steady: { mark: '●', label: 'Steady' },
  weakening: { mark: '▼', label: 'Getting weaker' },
  new: { mark: '★', label: 'New pick' },
  search: { mark: '⌕', label: 'Your Search pick' },
}

const valuesFor = (snap: Snapshot, data: PhoneData) => holdingValues(data.shares, data.holdings, snap.prices?.quotes ?? {})

// --- freshness --------------------------------------------------------------------------------

export function FreshnessBar({ snap, fresh }: { snap: Snapshot; fresh: Freshness }) {
  return (
    <div className="space-y-2">
      <p className="muted text-xs" data-testid="prices-as-of">
        Prices as of the close on <b>{fresh.price_day ? fmtDay(fresh.price_day) : '—'}</b> · updated {fmtTimestamp(snap.generated_at)}
      </p>
      {fresh.stale && (
        <div role="alert" className="stamp p-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="stamp-label">Old data</span>
            <span className="font-bold">These aren’t today’s prices.</span>
          </div>
          <p className="mt-2 text-sm">{fresh.reason}</p>
          <p className="mt-1 text-sm">Buy amounts are hidden until fresh prices arrive, so you never act on old numbers.</p>
        </div>
      )}
    </div>
  )
}

// --- top 3 for new money ------------------------------------------------------------------

export function TopThree({ snap, data, targets, fresh }: { snap: Snapshot; data: PhoneData; targets: SnapTarget[]; fresh: Freshness }) {
  const quotes = snap.prices?.quotes ?? {}
  const amount = data.schedule?.amount ?? 75
  const skip = skipFor(targets)
  const split = new Map(splitContribution(amount, targets, valuesFor(snap, data), skip).allocations.map((a) => [a.symbol, a.amount]))
  const eligible = targets.filter((t) => t.kind === 'stock' && !skip.has(t.symbol) && t.status !== 'watch')
  const ranked = [...eligible].sort((a, b) => (split.get(b.symbol) ?? 0) - (split.get(a.symbol) ?? 0)
    || (b.weight ?? 1) - (a.weight ?? 1) || (a.symbol < b.symbol ? -1 : 1))
  const top = ranked.slice(0, 3)
  return (
    <Card>
      <div className="eyebrow">3 to put new money in</div>
      <p className="muted mt-1 text-xs">Picked by business strength, which way each company is heading, a price check, and how far behind its target it is. Re-ranked every weekday.</p>
      {top.length === 0 ? (
        <p className="mt-3 text-sm">No company qualifies right now (all are on watch or priced well above their usual level), so new money goes to the index funds. That’s the plan working, not a problem.</p>
      ) : (
        <ol className="mt-3 space-y-4">
          {top.map((t, i) => {
            const q = quotes[t.symbol]
            const tr = TREND[t.trend ?? 'new']
            const dollars = split.get(t.symbol)
            const high = snap.prices?.history ? belowHigh(t.symbol, snap.prices.history) : null
            return (
              <li key={t.symbol} className="border-l-2 border-[var(--color-brand-2)] pl-3">
                <div className="flex items-baseline gap-2">
                  <span className="muted font-mono text-sm">{String(i + 1).padStart(2, '0')}</span>
                  <b className="font-mono text-lg">{t.symbol}</b>
                  <span className="muted min-w-0 flex-1 truncate text-xs">{t.name}</span>
                  {!fresh.stale && dollars !== undefined && <b className="font-mono">{fmtMoney(dollars)}</b>}
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs">
                  <span><span aria-hidden>{tr.mark} </span>{tr.label}</span>
                  {q?.dividend_yield_pct ? <span>Pays {fmtPct(q.dividend_yield_pct)} a year in dividends</span> : null}
                  {high && high.pct >= 1 && <span className="muted">{high.pct.toFixed(0)}% below its 1-yr high</span>}
                </div>
                {t.affinity_reason && <p className="mt-1 text-xs">{t.affinity_reason}</p>}
                {t.valuation && <p className="muted mt-1 text-xs">{t.valuation.detail}</p>}
              </li>
            )
          })}
        </ol>
      )}
      {top.length > 0 && top.length < 3 && <p className="muted mt-3 text-xs">Only {String(top.length)} qualify right now; the rest of new money goes to the index funds.</p>}
      {!fresh.stale && top.length > 0 && <p className="muted mt-3 text-xs">Dollar amounts are each one’s share of your next {fmtMoney(amount)} buy.</p>}
      <Explain title="How are these picked?">
        <p>Every company in the plan passed tests on its official SEC reports (growing sales, real profit, cash coming in, manageable debt). From those, these three come first because:</p>
        <p><b>Direction:</b> ones whose business got stronger since last quarter earn a bigger share (“affinity”); weakening ones get less, and one that fails a quarterly check goes <b>on watch</b> and is left out here.</p>
        <p><b>Price check:</b> a company priced well above its own usual price-to-earnings level is skipped for new money until that cools off.</p>
        <p><b>Your mix:</b> whatever is furthest behind its target comes first, so you never have to sell to stay balanced.</p>
        <p>None of this tries to guess tomorrow’s price. It changes when the businesses change.</p>
      </Explain>
    </Card>
  )
}

// --- sleeve vs index ----------------------------------------------------------------------

export function SleeveCard({ snap, data }: { snap: Snapshot; data: PhoneData }) {
  const funds = snap.rules.core_funds?.map((f) => f.symbol) ?? ['VTI', 'VXUS']
  const bench = funds[0] ?? 'VTI'
  const history = snap.prices?.history
  const r = history ? sleeveVsIndex(data.trades, history, new Set(funds), bench) : null
  return (
    <Card>
      <div className="eyebrow">Your picks vs. just {bench}</div>
      {!r ? (
        <p className="mt-2 text-sm">{data.trades.length === 0
          ? 'Import your Robinhood report (Invest tab) and this shows whether your individual stocks are beating the same dollars put into the index fund on the same days.'
          : 'None of your individual stocks has a price history here yet, so there’s nothing to compare.'}</p>
      ) : (
        <>
          <p className="muted mt-1 text-xs">Since {fmtDay(r.start_day)}: your stocks ({r.symbols.join(', ')}) vs. a pretend {bench} account that got the exact same dollars on the exact same days.</p>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <div>
              <div className="muted text-xs">Your stocks</div>
              <div className="serif text-2xl font-bold">{fmtMoney(r.sleeve_value)}</div>
              <div className={`font-mono text-xs ${gainClass(r.sleeve_gain)}`}>{fmtSignedMoney(r.sleeve_gain)} gain</div>
            </div>
            <div>
              <div className="muted text-xs">Same dollars in {bench}</div>
              <div className="serif text-2xl font-bold">{fmtMoney(r.shadow_value)}</div>
              <div className={`font-mono text-xs ${gainClass(r.shadow_gain)}`}>{fmtSignedMoney(r.shadow_gain)} gain</div>
            </div>
          </div>
          <p className="mt-3 text-sm font-semibold">
            {r.sleeve_gain >= r.shadow_gain
              ? <><span aria-hidden>▲ </span>Your picks are ahead by {fmtMoney(r.sleeve_gain - r.shadow_gain)}.</>
              : <><span aria-hidden>▼ </span>Just holding {bench} would have made {fmtMoney(r.shadow_gain - r.sleeve_gain)} more.</>}
          </p>
          {r.left_out.length > 0 && <p className="muted mt-2 text-xs">Not counted (no price history here): {r.left_out.join(', ')}.</p>}
        </>
      )}
      <Explain title="Why compare with the index?">
        <p>Picking individual companies only makes sense if, over time, they do better than simply owning the whole market. This keeps score honestly: same money, same days, real closing prices.</p>
        <p>A year is short; judge over several. If the index keeps winning, a bigger index share (Plan tab) is a perfectly good answer.</p>
      </Explain>
    </Card>
  )
}

// --- overlap ------------------------------------------------------------------------------

export function OverlapCard({ snap, targets }: { snap: Snapshot; targets: SnapTarget[] }) {
  const ov = snap.overlap
  const fund = ov?.fund ?? 'VTI'
  const fundPct = targets.find((t) => t.symbol === fund)?.target_pct ?? 0
  const stocks = targets.filter((t) => t.kind === 'stock')
  const top = new Map((ov?.top ?? []).map((h) => [h.symbol, h.weight_pct]))
  const minTop = ov?.top.length ? Math.min(...ov.top.map((h) => h.weight_pct)) : null
  const rows = stocks.map((t) => {
    const w = top.get(t.symbol)
    const via = w !== undefined ? (fundPct * w) / 100 : null
    return { t, w, via, total: via !== null ? t.target_pct + via : null }
  })
  const knownVia = rows.reduce((a, r) => a + (r.via ?? 0), 0)
  if (stocks.length === 0) return null
  return (
    <Card title={`What ${fund} already owns`}>
      <p className="text-sm">{fund} follows the whole US stock market, so it already owns US companies like these. Your real stake in each company is what you hold directly <b>plus</b> its slice inside {fund}.</p>
      {ov && ov.top.length > 0 ? (
        <>
          <p className="mt-2 text-sm">Through {fund} alone, about <b>{fmtPct(knownVia)}</b> of your money is already in {String(rows.filter((r) => r.via !== null).length)} of these companies (from {fund}’s published top holdings).</p>
          <table className="mt-3 w-full text-sm">
            <thead><tr className="muted text-left text-xs"><th className="font-normal">Company</th><th className="font-normal">Direct</th><th className="font-normal">Inside {fund}</th><th className="font-normal">Total</th></tr></thead>
            <tbody>
              {rows.map(({ t, via, total }) => (
                <tr key={t.symbol} className="border-t border-[var(--line)]">
                  <td className="py-1 font-mono font-bold">{t.symbol}</td>
                  <td className="font-mono">{fmtPct(t.target_pct)}</td>
                  <td className="font-mono">{via !== null ? fmtPct(via, 2) : minTop !== null ? `< ${fmtPct((fundPct * minTop) / 100, 2)}` : '—'}</td>
                  <td className="font-mono">{total !== null ? fmtPct(total) : `≈ ${fmtPct(t.target_pct)}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted mt-2 text-xs">Source: {ov.source}, {fmtTimestamp(ov.fetched_at)}. Companies outside {fund}’s top holdings own less than its smallest listed slice.</p>
        </>
      ) : (
        <p className="muted mt-2 text-xs">{fund}’s holdings list couldn’t be loaded today{ov?.error ? ` (${ov.error})` : ''}, so the overlap isn’t shown rather than guessed.</p>
      )}
    </Card>
  )
}

// --- funds / stocks split -------------------------------------------------------------------

export function SplitSetting({ snap, data, update }: { snap: Snapshot; data: PhoneData; update: (d: PhoneData) => void }) {
  const current = data.core_pct ?? snap.rules.core_pct ?? 60
  return (
    <Card title="Your mix">
      <p className="text-sm">How much goes to the two index funds vs. your individual companies. More in the funds = smoother ride; more in companies = more depends on the picks.</p>
      <div role="radiogroup" aria-label="Funds and companies split" className="mt-3 grid grid-cols-3 gap-2">
        {CORE_CHOICES.map((c) => (
          <button key={c} type="button" role="radio" aria-checked={current === c}
            className={`btn ${current === c ? '' : 'btn-ghost'} px-2`} onClick={() => { update({ ...data, core_pct: c }) }}>
            {String(c)}/{String(100 - c)}
          </button>
        ))}
      </div>
      <p className="muted mt-2 text-xs">{String(current)}% index funds · {String(100 - current)}% companies. No single company ever gets more than {fmtPct(snap.rules.max_single_stock_pct ?? 8, 0)}.</p>
    </Card>
  )
}

// --- company status -------------------------------------------------------------------------

export function CompanyStatus({ snap, targets }: { snap: Snapshot; targets: SnapTarget[] }) {
  const stocks = targets.filter((t) => t.kind === 'stock')
  const replaced = Object.entries(snap.plan.watch ?? {}).filter(([, s]) => s === 'replace').map(([sym]) => sym)
  if (stocks.length === 0) return null
  return (
    <Card title="Company check-ins">
      <p className="muted text-xs">Checked against their SEC reports every quarter{snap.plan.quarter ? ` (now ${snap.plan.quarter})` : ''}. One failed check = on watch. Two in a row = replaced: new money stops. Nothing is ever sold for you.</p>
      <ul className="mt-3 divide-y divide-[var(--line)]">
        {stocks.map((t) => (
          <li key={t.symbol} className="py-2 text-sm">
            <div className="flex flex-wrap items-baseline gap-x-3">
              <b className="w-14 font-mono">{t.symbol}</b>
              <span>{t.status === 'watch' ? '⚠️ On watch' : '✓ Passing'}</span>
              <span className="muted text-xs"><span aria-hidden>{TREND[t.trend ?? 'new'].mark} </span>{TREND[t.trend ?? 'new'].label}</span>
              {t.valuation?.flagged && <span className="text-xs text-[var(--color-warn)]">Price check: new money paused</span>}
            </div>
            {t.valuation && <p className="muted mt-1 pl-[4.25rem] text-xs">{t.valuation.detail}</p>}
          </li>
        ))}
      </ul>
      {replaced.length > 0 && (
        <p className="mt-3 text-sm">Replaced: <b className="font-mono">{replaced.join(', ')}</b>. They failed two quarterly checks in a row, so new money stopped going to them. If you own them, keeping or selling is your call; the app never tells you to sell.</p>
      )}
    </Card>
  )
}

// --- backups ------------------------------------------------------------------------------

const hasData = (d: PhoneData) => d.entries.length > 0 || Object.keys(d.shares).length > 0 || Object.keys(d.holdings).length > 0 || d.trades.length > 0

export function BackupReminder({ data, now }: { data: PhoneData; now: Date }) {
  if (!hasData(data)) return null
  const age = data.last_backup_at ? (now.getTime() - Date.parse(data.last_backup_at)) / 86_400_000 : Infinity
  if (age < BACKUP_EVERY_DAYS) return null
  return (
    <a href="#/wall" className="block border-l-4 border-[var(--color-warn)] bg-[var(--panel)] p-3 text-sm">
      <b>Time for a backup.</b> {data.last_backup_at ? `Your last one was ${fmtTimestamp(data.last_backup_at)}.` : 'You haven’t saved one yet.'} If this phone is lost, a backup is the only copy of your holdings and wall. Tap to save one →
    </a>
  )
}

interface Pending { text: string; encrypted: boolean; preview: PhoneData | null; savedAt: string | null }

export function BackupCard({ data, update }: { data: PhoneData; update: (d: PhoneData) => void }) {
  const [pass, setPass] = useState('')
  const [pass2, setPass2] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [openPass, setOpenPass] = useState('')

  async function save(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault()
    if (pass.length < MIN_PASSPHRASE) { setMsg(`Use a passphrase of at least ${String(MIN_PASSPHRASE)} characters. A short sentence works well.`); return }
    if (pass !== pass2) { setMsg('The two passphrases don’t match.'); return }
    setBusy(true)
    try {
      const now = new Date()
      const marked: PhoneData = { ...data, last_backup_at: now.toISOString() }
      const text = await encryptBackup(marked, pass, now)
      const name = `keystone-backup-${now.toISOString().slice(0, 10)}.json`
      const file = new File([text], name, { type: 'application/json' })
      let shared = false
      try {
        if ('canShare' in navigator && navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: 'Keystone Ledger backup' })
          shared = true
        }
      } catch {
        // share sheet closed: fall back to a download
      }
      if (!shared) {
        const url = URL.createObjectURL(file)
        const a = document.createElement('a')
        a.href = url
        a.download = name
        a.click()
        URL.revokeObjectURL(url)
      }
      update(marked)
      setPass(''); setPass2('')
      setMsg('✓ Locked backup saved. Keep the passphrase somewhere safe: without it, the file can’t be opened, by anyone, including you.')
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Couldn’t make the backup.')
    } finally {
      setBusy(false)
    }
  }

  async function pick(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    e.target.value = ''
    setMsg(null); setPending(null); setOpenPass('')
    if (!f) return
    if (f.size > 5_000_000) { setMsg('That file is too big to be a backup.'); return }
    const text = await f.text()
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch { setMsg('That file isn’t a Keystone Ledger backup.'); return }
    if (isEncrypted(parsed)) { setPending({ text, encrypted: true, preview: null, savedAt: null }); return }
    try {
      const r = await openBackup(text, null)
      setPending({ text, encrypted: false, preview: r.data, savedAt: r.saved_at })
    } catch (err) { setMsg(err instanceof Error ? err.message : 'Couldn’t read that file.') }
  }

  async function unlock(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!pending) return
    setBusy(true)
    try {
      const r = await openBackup(pending.text, openPass)
      setPending({ ...pending, preview: r.data, savedAt: r.saved_at })
      setMsg(null)
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Couldn’t open that backup.')
    } finally {
      setBusy(false)
    }
  }

  function replace() {
    if (!pending?.preview) return
    update(pending.preview)
    setPending(null); setOpenPass('')
    setMsg('✓ Backup restored.')
  }

  const p = pending?.preview
  return (
    <Card title="Back up everything (locked)">
      <p className="text-sm">Your holdings, history, wall and schedule live <b>only on this phone</b>. Save a locked copy: one file sealed with your passphrase. Keep it in <b>iCloud Drive</b>, on a <b>USB thumb drive</b> (plug it in, then “Save to Files” → the drive), or both.</p>
      <form onSubmit={(e) => void save(e)} className="mt-3 space-y-2">
        <input className="input w-full" type="password" autoComplete="new-password" placeholder="Passphrase (10+ characters)" value={pass} onChange={(e) => { setPass(e.target.value) }} aria-label="Backup passphrase" />
        <input className="input w-full" type="password" autoComplete="new-password" placeholder="Type it again" value={pass2} onChange={(e) => { setPass2(e.target.value) }} aria-label="Repeat backup passphrase" />
        <button className="btn w-full" disabled={busy}>{busy ? 'Locking…' : 'Save locked backup'}</button>
      </form>
      <p className="muted mt-2 text-xs">{data.last_backup_at ? `Last backup: ${fmtTimestamp(data.last_backup_at)}.` : 'No backup yet.'} A reminder shows on Today every {String(BACKUP_EVERY_DAYS)} days.</p>

      <div className="mt-5 border-t border-[var(--line)] pt-4">
        <label className="btn btn-ghost w-full cursor-pointer">Restore from a backup
          <input type="file" accept="application/json,.json" className="sr-only" onChange={(e) => void pick(e)} aria-label="Backup file to restore" />
        </label>
        {pending && !p && (
          <form onSubmit={(e) => void unlock(e)} className="mt-3 space-y-2">
            <input className="input w-full" type="password" autoComplete="current-password" placeholder="This backup’s passphrase" value={openPass} onChange={(e) => { setOpenPass(e.target.value) }} aria-label="Passphrase to open the backup" />
            <button className="btn w-full" disabled={busy}>{busy ? 'Opening…' : 'Open backup'}</button>
          </form>
        )}
        {p && (
          <div className="mt-3 space-y-2 text-sm" role="group" aria-label="Backup contents">
            <p>This backup{pending.savedAt ? ` from ${fmtTimestamp(pending.savedAt)}` : ''} has {String(Object.keys(p.shares).length + Object.keys(p.holdings).length)} holdings, {String(p.trades.length)} trades and {String(p.entries.length)} stones. It checked out: nothing in it was changed.</p>
            {hasData(data) && <p className="font-semibold text-[var(--color-warn)]">Restoring replaces everything on this phone now ({String(data.entries.length)} stones, {String(Object.keys(data.shares).length + Object.keys(data.holdings).length)} holdings).</p>}
            <div className="flex gap-2">
              <button type="button" className="btn flex-1" onClick={replace}>{hasData(data) ? 'Replace everything on this phone' : 'Restore this backup'}</button>
              <button type="button" className="btn btn-ghost" onClick={() => { setPending(null) }}>Cancel</button>
            </div>
          </div>
        )}
      </div>
      {msg && <p role="status" className="mt-3 text-sm">{msg}</p>}
      <Explain title="How safe is the locked file?">
        <p>It’s encrypted on this phone with AES-256 (the standard banks use), using a key made from your passphrase. The file never goes anywhere you don’t send it.</p>
        <p>If anyone changes even one character of the file, it refuses to open, so a damaged copy can never half-overwrite your data.</p>
        <p><b>Keep the passphrase safe.</b> There’s no reset: that’s what makes it private.</p>
      </Explain>
    </Card>
  )
}

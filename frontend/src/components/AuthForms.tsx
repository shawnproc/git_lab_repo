import { type SubmitEvent, useState } from 'react'
import { ApiError, type AuthStatus, api } from '../api'

interface Props {
  onAuthed: (status: AuthStatus) => void
}

function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429 && err.retryAfter) {
      return `${err.message} (locked for ~${Math.ceil(err.retryAfter / 60)} min)`
    }
    return err.message
  }
  return 'Could not reach the local server.'
}

function Shell({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto mt-16 w-full max-w-md px-4">
      <div className="panel p-8 shadow-2xl shadow-black/20">
        <div className="mb-6">
          <div className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--color-brand)]">
            Keystone Ledger
          </div>
          <h1 className="mt-2 text-2xl font-bold">{title}</h1>
          <p className="muted mt-1 text-sm">{subtitle}</p>
        </div>
        {children}
      </div>
    </div>
  )
}

export function SetupForm({ onAuthed }: Props) {
  const [token, setToken] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const mismatch = confirm.length > 0 && password !== confirm

  async function submit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault()
    if (mismatch) return
    setBusy(true)
    setError(null)
    try {
      onAuthed(await api.setup(token.trim(), username.trim(), password))
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Shell
      title="First-run setup"
      subtitle="Paste the one-time setup token printed in the terminal where you started the app."
    >
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <label className="block text-sm">
          Setup token
          <input className="input mt-1 font-mono" value={token} onChange={(e) => { setToken(e.target.value) }} autoComplete="off" required />
        </label>
        <label className="block text-sm">
          Username
          <input className="input mt-1" value={username} onChange={(e) => { setUsername(e.target.value) }} autoComplete="username" required minLength={3} maxLength={32} />
        </label>
        <label className="block text-sm">
          Password <span className="muted">(12+ characters; a passphrase is best)</span>
          <input className="input mt-1" type="password" value={password} onChange={(e) => { setPassword(e.target.value) }} autoComplete="new-password" required minLength={12} maxLength={256} />
        </label>
        <label className="block text-sm">
          Confirm password
          <input className="input mt-1" type="password" value={confirm} onChange={(e) => { setConfirm(e.target.value) }} autoComplete="new-password" required />
        </label>
        {mismatch && <p className="text-sm text-[var(--color-down)]">Passwords don’t match.</p>}
        {error && <p role="alert" className="text-sm text-[var(--color-down)]">{error}</p>}
        <button className="btn w-full" disabled={busy || mismatch}>
          {busy ? 'Creating…' : 'Create account'}
        </button>
      </form>
    </Shell>
  )
}

export function LoginForm({ onAuthed }: Props) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      onAuthed(await api.login(username.trim(), password))
    } catch (err) {
      setError(errorText(err))
      setPassword('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Shell title="Good morning" subtitle="Sign in to see today’s market mood and your money.">
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <label className="block text-sm">
          Username
          <input className="input mt-1" value={username} onChange={(e) => { setUsername(e.target.value) }} autoComplete="username" required />
        </label>
        <label className="block text-sm">
          Password
          <input className="input mt-1" type="password" value={password} onChange={(e) => { setPassword(e.target.value) }} autoComplete="current-password" required />
        </label>
        {error && <p role="alert" className="text-sm text-[var(--color-down)]">{error}</p>}
        <button className="btn w-full" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </Shell>
  )
}

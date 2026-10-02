import { useCallback, useEffect, useState } from 'react'
import { type AuthStatus, api, setCsrfToken } from './api'
import { LoginForm, SetupForm } from './components/AuthForms'
import { Dashboard } from './components/Dashboard'
import { type Theme, applyTheme, loadTheme } from './theme'

type View = 'loading' | 'offline' | 'setup' | 'login' | 'app'

export default function App() {
  const [view, setView] = useState<View>('loading')
  const [username, setUsername] = useState<string | null>(null)
  const [theme, setTheme] = useState<Theme>(loadTheme)

  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  const accept = useCallback((s: AuthStatus) => {
    setCsrfToken(s.csrf_token)
    setUsername(s.username)
    setView(s.setup_required ? 'setup' : s.authenticated ? 'app' : 'login')
  }, [])

  useEffect(() => {
    api.authStatus().then(accept, () => { setView('offline') })
  }, [accept])

  const signedOut = useCallback(() => {
    setCsrfToken(null)
    setUsername(null)
    setView('login')
  }, [])

  async function logout() {
    try {
      await api.logout()
    } finally {
      signedOut()
    }
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-5">
        <div className="flex items-center gap-3">
          <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-[var(--color-brand)] to-[var(--color-brand-2)]" />
          <span className="text-lg font-bold tracking-tight">Keystone Ledger</span>
          <span className="rounded-full border border-[var(--line)] px-2 py-0.5 text-xs muted">PAPER</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="btn btn-ghost px-3 py-1.5 text-sm"
            onClick={() => { setTheme(theme === 'dark' ? 'light' : 'dark') }}
            aria-label="Toggle theme"
          >
            {theme === 'dark' ? '☀︎ Light' : '☾ Dark'}
          </button>
          {view === 'app' && (
            <button className="btn btn-ghost px-3 py-1.5 text-sm" onClick={() => void logout()}>
              Sign out{username ? ` (${username})` : ''}
            </button>
          )}
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-12">
        {view === 'loading' && <p className="muted">Loading…</p>}
        {view === 'offline' && (
          <p role="alert" className="text-[var(--color-down)]">
            Can’t reach the local server. Start it with <code>make run</code>.
          </p>
        )}
        {view === 'setup' && <SetupForm onAuthed={accept} />}
        {view === 'login' && <LoginForm onAuthed={accept} />}
        {view === 'app' && <Dashboard onUnauthorized={signedOut} />}
      </main>

      <footer className="border-t border-[var(--line)] py-4 text-center text-xs muted">
        Educational tool, not financial advice. Paper trading only. Every number shows its source and timestamp.
      </footer>
    </div>
  )
}

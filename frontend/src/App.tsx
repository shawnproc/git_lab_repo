import { useCallback, useEffect, useMemo, useState } from 'react'
import { type AuthStatus, api, setCsrfToken } from './api'
import { LoginForm, SetupForm } from './components/AuthForms'
import { Charts } from './pages/Charts'
import { Home } from './pages/Home'
import { Learn } from './pages/Learn'
import { Money } from './pages/Money'
import { Plan } from './pages/Plan'
import { SessionContext } from './session'
import { type Theme, applyTheme, loadTheme } from './theme'

type View = 'loading' | 'offline' | 'setup' | 'login' | 'app'

export const PAGES = [
  { id: 'home', label: 'Home' },
  { id: 'plan', label: 'My Plan' },
  { id: 'money', label: 'My Money' },
  { id: 'charts', label: 'Charts' },
  { id: 'learn', label: 'Learn' },
] as const
type PageId = (typeof PAGES)[number]['id']

function pageFromHash(): PageId {
  const h = window.location.hash.replace(/^#\/?/, '')
  return PAGES.some((p) => p.id === h) ? (h as PageId) : 'home'
}

export default function App() {
  const [view, setView] = useState<View>('loading')
  const [username, setUsername] = useState<string | null>(null)
  const [theme, setTheme] = useState<Theme>(loadTheme)
  const [page, setPage] = useState<PageId>(pageFromHash)

  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  useEffect(() => {
    const onHash = () => { setPage(pageFromHash()) }
    window.addEventListener('hashchange', onHash)
    return () => { window.removeEventListener('hashchange', onHash) }
  }, [])

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
  const session = useMemo(() => ({ onUnauthorized: signedOut }), [signedOut])

  async function logout() {
    try {
      await api.logout()
    } finally {
      signedOut()
    }
  }

  return (
    <SessionContext.Provider value={session}>
      <div className="flex min-h-screen flex-col">
        <header className="mx-auto w-full max-w-6xl px-4 py-5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-[var(--color-brand)] to-[var(--color-brand-2)]" />
              <span className="text-lg font-bold tracking-tight">Keystone Ledger</span>
            </div>
            <div className="flex items-center gap-2">
              <button className="btn btn-ghost px-3 py-1.5 text-sm" aria-label="Toggle theme"
                onClick={() => { setTheme(theme === 'dark' ? 'light' : 'dark') }}>
                {theme === 'dark' ? '☀︎ Light' : '☾ Dark'}
              </button>
              {view === 'app' && (
                <button className="btn btn-ghost px-3 py-1.5 text-sm" onClick={() => void logout()}>
                  Sign out{username ? ` (${username})` : ''}
                </button>
              )}
            </div>
          </div>
          {view === 'app' && (
            <nav aria-label="Main" className="mt-4 flex gap-1 overflow-x-auto">
              {PAGES.map((p) => (
                <a key={p.id} href={`#/${p.id}`} aria-current={page === p.id ? 'page' : undefined}
                  className={`whitespace-nowrap rounded-lg px-4 py-2 text-sm font-semibold ${
                    page === p.id ? 'bg-[var(--panel-2)] text-[var(--color-brand)]' : 'muted hover:bg-[var(--panel-2)]'
                  }`}>
                  {p.label}
                </a>
              ))}
            </nav>
          )}
        </header>

        <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-12">
          {view === 'loading' && <p className="muted">Loading…</p>}
          {view === 'offline' && (
            <p role="alert" className="text-[var(--color-down)]">
              Can’t reach the app’s server. In PowerShell, run <code>.\tasks.ps1 run</code> and keep that window open.
            </p>
          )}
          {view === 'setup' && <SetupForm onAuthed={accept} />}
          {view === 'login' && <LoginForm onAuthed={accept} />}
          {view === 'app' && page === 'home' && <Home />}
          {view === 'app' && page === 'plan' && <Plan />}
          {view === 'app' && page === 'money' && <Money />}
          {view === 'app' && page === 'charts' && <Charts theme={theme} />}
          {view === 'app' && page === 'learn' && <Learn />}
        </main>

        <footer className="border-t border-[var(--line)] py-4 text-center text-xs muted">
          Educational tool, not financial advice. It never connects to a broker or places trades. Every number shows
          where it came from and when.
        </footer>
      </div>
    </SessionContext.Provider>
  )
}

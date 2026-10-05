import { useCallback, useEffect, useMemo, useState } from 'react'
import { type AuthStatus, api, setCsrfToken } from './api'
import { LoginForm, SetupForm } from './components/AuthForms'
import { KeystoneLogo } from './components/brand'
import { Charts } from './pages/Charts'
import { Home } from './pages/Home'
import { Learn } from './pages/Learn'
import { Money } from './pages/Money'
import { Plan } from './pages/Plan'
import { Search } from './pages/Search'
import { SessionContext } from './session'
import { type Theme, applyTheme, loadTheme } from './theme'

type View = 'loading' | 'offline' | 'setup' | 'login' | 'app'

export const PAGES = [
  { id: 'home', label: 'Home' },
  { id: 'search', label: 'Search' },
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
        <header className="mx-auto w-full max-w-6xl px-4 pt-6 sm:pl-20">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <KeystoneLogo size={42} />
              <div>
                <div className="serif text-xl font-bold leading-none tracking-tight sm:text-2xl">Keystone Ledger</div>
                <div className="eyebrow mt-1 hidden sm:block">Build it stone by stone</div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button className="btn btn-ghost px-3 py-1.5 text-sm" aria-label="Toggle theme"
                title={theme === 'dark' ? 'Switch to Prism (light)' : 'Switch to Aurora (dark)'}
                onClick={() => { setTheme(theme === 'dark' ? 'light' : 'dark') }}>
                {theme === 'dark' ? '☀ Prism' : '✦ Aurora'}
              </button>
              {view === 'app' && (
                <button className="btn btn-ghost px-3 py-1.5 text-sm" onClick={() => void logout()}>
                  Sign out<span className="hidden sm:inline">{username ? ` (${username})` : ''}</span>
                </button>
              )}
            </div>
          </div>
          {view === 'app' && (
            <nav aria-label="Main" className="mt-6 flex gap-1 overflow-x-auto border-b-2 border-[var(--ink)]">
              {PAGES.map((p) => (
                <a key={p.id} href={`#/${p.id}`} aria-current={page === p.id ? 'page' : undefined} className="tab text-sm sm:text-base">
                  {p.label}
                </a>
              ))}
            </nav>
          )}
        </header>

        <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-16 pt-8 sm:pl-20">
          {view === 'loading' && <p className="muted">Loading…</p>}
          {view === 'offline' && (
            <p role="alert" className="text-[var(--color-down)]">
              Can’t reach the app’s server. In PowerShell, run <code>.\tasks.ps1 run</code> and keep that window open.
            </p>
          )}
          {view === 'setup' && <SetupForm onAuthed={accept} />}
          {view === 'login' && <LoginForm onAuthed={accept} />}
          {view === 'app' && page === 'home' && <Home />}
          {view === 'app' && page === 'search' && <Search />}
          {view === 'app' && page === 'plan' && <Plan />}
          {view === 'app' && page === 'money' && <Money />}
          {view === 'app' && page === 'charts' && <Charts theme={theme} />}
          {view === 'app' && page === 'learn' && <Learn />}
        </main>

        <footer className="mx-auto w-full max-w-6xl border-t-2 border-[var(--line)] px-4 py-5 text-xs muted sm:pl-20">
          <div className="flex flex-wrap justify-between gap-2">
            <span className="serif italic">Keystone Ledger: an educational tool, not financial advice.</span>
            <span className="font-mono">NEVER CONNECTS TO A BROKER · EVERY NUMBER SHOWS ITS SOURCE</span>
          </div>
        </footer>
      </div>
    </SessionContext.Provider>
  )
}

// The PC app's Search page: the same screen as the phone, with the watchlist saved in the PC
// app's own database (so Plan and the buy-day split on this computer can use it).
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, ApiError, type WatchRow } from '../api'
import { ErrorText } from '../components/ui'
import { parseResearch, type Research } from '../phone/research'
import { SearchPage, type Watch } from '../phone/Search'
import { useSession } from '../session'
import { errorMessage } from '../useApi'

export function Search() {
  const { onUnauthorized } = useSession()
  const [research, setResearch] = useState<Research | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [items, setItems] = useState<WatchRow[]>([])
  const [problem, setProblem] = useState<string | null>(null)

  const fail = useCallback((e: unknown) => {
    if (e instanceof ApiError && e.status === 401) onUnauthorized()
    else setProblem(errorMessage(e))
  }, [onUnauthorized])

  useEffect(() => {
    let cancelled = false
    async function go() {
      // Cached copy first (instant), then today's file if the copy is over 6 hours old.
      for (const load of [api.research, api.refreshResearch]) {
        const r = await load()
        if (cancelled) return
        if (r.data) {
          try { setResearch(parseResearch(r.data)); setError(r.status.stale ? `Old search data: ${r.status.reason}.` : null) } catch { setError('The search data looks damaged.') }
        } else setError(r.status.last_error ? `Search data isn’t available: ${r.status.last_error}` : 'Downloading the search data…')
      }
    }
    go().catch((e: unknown) => { if (!cancelled) fail(e) })
    api.watchlist().then((w) => { if (!cancelled) setItems(w) }, fail)
    return () => { cancelled = true }
  }, [fail])

  const watch: Watch = useMemo(() => ({
    items,
    device: 'computer',
    add: (c) => { api.watchAdd(c.s).then(setItems, fail) },
    remove: (s) => { api.watchRemove(s).then(() => { setItems((old) => old.filter((w) => w.symbol !== s)) }, fail) },
    setInclude: (s, on) => { api.watchInclude(s, on).then(setItems, fail) },
  }), [items, fail])

  return (
    <div>
      {problem && <div className="mb-4"><ErrorText>{problem}</ErrorText></div>}
      <div className="mx-auto max-w-2xl">
        <SearchPage research={research} error={error} watch={watch} chart={() => null} />
      </div>
    </div>
  )
}

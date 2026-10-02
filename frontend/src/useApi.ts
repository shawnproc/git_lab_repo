import { useCallback, useEffect, useState } from 'react'
import { ApiError } from './api'
import { useSession } from './session'

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error && err.message) return err.message
  return 'Something went wrong talking to the app. Is it still running?'
}

/** Load data on mount; `run` performs an action (e.g. a refresh) that returns the same shape.
 * `load` must be stable (a module-level function), or it reloads on every render. */
export function useApi<T>(load: () => Promise<T>) {
  const { onUnauthorized } = useSession()
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const handle = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) onUnauthorized()
      else setError(errorMessage(err))
    },
    [onUnauthorized],
  )

  useEffect(() => {
    let cancelled = false
    load().then(
      (d) => {
        if (!cancelled) {
          setData(d)
          setLoading(false)
        }
      },
      (err: unknown) => {
        if (!cancelled) {
          handle(err)
          setLoading(false)
        }
      },
    )
    return () => {
      cancelled = true
    }
  }, [load, handle])

  const run = useCallback(
    async (action: () => Promise<T>) => {
      setBusy(true)
      setError(null)
      try {
        setData(await action())
      } catch (err) {
        handle(err)
      } finally {
        setBusy(false)
      }
    },
    [handle],
  )

  return { data, error, loading, busy, run, setData }
}

// One live-price feed for the whole app (Today, Search, watchlist), so each symbol is looked up
// once a minute however many screens show it. Display only: buy math never reads it.
import { createContext, type ReactNode, useContext, useMemo, useState } from 'react'
import { type LiveState, loadKey, MAX_LIVE, useLiveQuotes } from './live'

export interface Live extends LiveState {
  key: string | null
  setKey: (k: string | null) => void
  /** The company open in Search: looked up first. */
  setFocus: (symbol: string | null) => void
}

const NONE: Live = { key: null, setKey: () => undefined, setFocus: () => undefined, quotes: {}, error: null, checkedAt: null, rounds: [] }
const LiveCtx = createContext<Live>(NONE)

export const useLive = () => useContext(LiveCtx)

/** `symbols`: what's worth watching, most important first (what you own, then your watchlist,
 * then the plan). Only the first MAX_LIVE are looked up. */
export function LiveProvider({ symbols, children }: { symbols: string[]; children: ReactNode }) {
  const [key, setKey] = useState<string | null>(loadKey)
  const [focus, setFocus] = useState<string | null>(null)
  const list = useMemo(() => [...new Set([...(focus ? [focus] : []), ...symbols])].slice(0, MAX_LIVE), [focus, symbols])
  const state = useLiveQuotes(list, key)
  const value = useMemo(() => ({ ...state, key, setKey, setFocus }), [state, key])
  return <LiveCtx.Provider value={value}>{children}</LiveCtx.Provider>
}

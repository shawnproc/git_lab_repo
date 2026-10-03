import { createContext, useContext } from 'react'

/** Lets any page report "your session expired" so the app returns to the sign-in screen. */
export const SessionContext = createContext<{ onUnauthorized: () => void }>({
  onUnauthorized: () => undefined,
})

export function useSession() {
  return useContext(SessionContext)
}

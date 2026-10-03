export type Theme = 'dark' | 'light'

const KEY = 'kl.theme'

export function loadTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark')
  document.documentElement.classList.toggle('light', theme === 'light')
  try {
    localStorage.setItem(KEY, theme)
  } catch {
    // storage unavailable (private mode); theme still applies for this session
  }
}

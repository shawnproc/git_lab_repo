import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { routeFetch } from './fixtures'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('auth screens', () => {
  it('shows first-run setup when no account exists', async () => {
    vi.stubGlobal('fetch', vi.fn(routeFetch({ 'GET /api/auth/status': { setup_required: true, authenticated: false, username: null, csrf_token: null } })))
    render(<App />)
    expect(await screen.findByText('First-run setup')).toBeInTheDocument()
    expect(screen.getByText(/not financial advice/i)).toBeInTheDocument()
  })

  it('shows login when signed out', async () => {
    vi.stubGlobal('fetch', vi.fn(routeFetch({ 'GET /api/auth/status': { setup_required: false, authenticated: false, username: null, csrf_token: null } })))
    render(<App />)
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument()
  })

  it('tells a Windows user how to start the server when offline', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))))
    render(<App />)
    expect(await screen.findByText(/tasks.ps1 run/)).toBeInTheDocument()
  })
})

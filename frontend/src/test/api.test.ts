import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, request, setCsrfToken } from '../api'

function mockFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const fn = vi.fn((_url: string, _init: RequestInit) =>
    Promise.resolve(
      new Response(body === null ? null : JSON.stringify(body), { status, headers }),
    ),
  )
  vi.stubGlobal('fetch', fn)
  return fn
}

function headersOf(fn: ReturnType<typeof mockFetch>): Record<string, string> {
  const init = fn.mock.calls[0]?.[1]
  return (init?.headers ?? {}) as Record<string, string>
}

afterEach(() => {
  setCsrfToken(null)
  vi.unstubAllGlobals()
})

describe('request', () => {
  it('sends the CSRF token on state-changing requests only', async () => {
    setCsrfToken('tok')
    const post = mockFetch(200, { ok: true })
    await request('POST', '/api/x', {})
    expect(headersOf(post)['x-csrf-token']).toBe('tok')

    const get = mockFetch(200, { ok: true })
    await request('GET', '/api/x')
    expect(headersOf(get)['x-csrf-token']).toBeUndefined()
  })

  it('is same-origin and never follows redirects', async () => {
    const fn = mockFetch(200, {})
    await request('GET', '/api/x')
    const init = fn.mock.calls[0]?.[1]
    expect(init?.credentials).toBe('same-origin')
    expect(init?.redirect).toBe('error')
  })

  it('refuses non-API paths', async () => {
    await expect(request('GET', 'https://evil.example/api/x')).rejects.toThrow()
  })

  it('surfaces FastAPI error details and retry-after', async () => {
    mockFetch(429, { detail: 'too many failed attempts' }, { 'retry-after': '120' })
    const err = await request('POST', '/api/auth/login', {}).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(429)
    expect((err as ApiError).message).toBe('too many failed attempts')
    expect((err as ApiError).retryAfter).toBe(120)
  })

  it('joins validation error messages', async () => {
    mockFetch(422, { detail: [{ msg: 'a' }, { msg: 'b' }] })
    await expect(request('POST', '/api/x', {})).rejects.toThrow('a; b')
  })
})

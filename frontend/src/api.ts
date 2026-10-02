// Thin, typed client for the local API. Same-origin only; the session cookie is httpOnly, so the
// only secret JS ever holds is the per-session CSRF token (kept in memory, never in storage).

export interface Freshness {
  source: string | null
  fetched_at: string | null
  last_day: string | null
  expected_day: string
  stale: boolean
  reason: string
  last_error: string
}

export interface AuthStatus {
  setup_required: boolean
  authenticated: boolean
  username: string | null
  csrf_token: string | null
}

export interface MarketStatus {
  benchmark: string
  benchmark_close: number | null
  benchmark_day: string | null
  benchmark_freshness: Freshness
  vix: number | null
  vix_day: string | null
  vix_freshness: Freshness
  any_stale: boolean
}

export class ApiError extends Error {
  readonly status: number
  readonly retryAfter: number | null

  constructor(status: number, message: string, retryAfter: number | null = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.retryAfter = retryAfter
  }
}

let csrfToken: string | null = null

export function setCsrfToken(token: string | null): void {
  csrfToken = token
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

function detailOf(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || !('detail' in body)) return null
  const detail = body.detail
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    // FastAPI validation errors: [{loc, msg}, ...]
    return detail
      .map((d: unknown) =>
        typeof d === 'object' && d !== null && 'msg' in d ? String(d.msg) : '',
      )
      .filter(Boolean)
      .join('; ')
  }
  return null
}

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (!path.startsWith('/api/')) throw new Error('API paths must start with /api/')
  const headers: Record<string, string> = { accept: 'application/json' }
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (UNSAFE.has(method) && csrfToken) headers['x-csrf-token'] = csrfToken

  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
  })
  if (res.status === 204) return undefined as T
  const text = await res.text()
  let parsed: unknown
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = null // non-JSON error page; fall back to the status code below
  }
  if (!res.ok) {
    const retry = res.headers.get('retry-after')
    throw new ApiError(
      res.status,
      detailOf(parsed) ?? `Request failed (${res.status})`,
      retry ? Number(retry) : null,
    )
  }
  return parsed as T
}

export const api = {
  authStatus: () => request<AuthStatus>('GET', '/api/auth/status'),
  setup: (setup_token: string, username: string, password: string) =>
    request<AuthStatus>('POST', '/api/auth/setup', { setup_token, username, password }),
  login: (username: string, password: string) =>
    request<AuthStatus>('POST', '/api/auth/login', { username, password }),
  logout: () => request<undefined>('POST', '/api/auth/logout'),
  marketStatus: () => request<MarketStatus>('GET', '/api/market/status'),
  marketRefresh: () => request<MarketStatus>('POST', '/api/market/refresh'),
}

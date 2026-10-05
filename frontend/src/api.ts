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

export type Mood = 'green' | 'yellow' | 'red' | 'unknown'

export interface MoodResult {
  mood: Mood
  headline: string
  reasons: string[]
  index_close: number | null
  index_ma: number | null
  vix: number | null
}

export interface Position {
  symbol: string
  shares: number
  avg_cost: number
  price: number | null
  value: number | null
  day_change: number | null
  cost_basis: number
}

export interface PortfolioSummary {
  positions: Position[]
  value: number
  cost_basis: number
  day_change: number
  day_change_pct: number | null
  total_change: number
  total_change_pct: number | null
  missing_prices: string[]
}

export interface Dashboard {
  mood: MoodResult
  index_freshness: Freshness
  vix_freshness: Freshness
  portfolio: PortfolioSummary
  holdings_freshness: Record<string, Freshness>
  any_stale: boolean
}

export type CheckStatus = 'pass' | 'fail' | 'unavailable'

export interface Check {
  key: string
  label: string
  status: CheckStatus
  detail: string
}

export interface ScreenResult {
  symbol: string
  sector: string
  company: string
  checks: Check[]
  qualifies: boolean
  score: number | null
  why: string
  picked: boolean
  note: string
}

export interface TargetRow {
  symbol: string
  name: string
  kind: 'core' | 'stock'
  target_pct: number
  target_value: number
  why: string
}

export interface FundamentalsStatus {
  source: string | null
  fetched_at: string | null
  stale: boolean
  reason: string
  last_error: string
}

export interface Plan {
  targets: TargetRow[]
  screen: ScreenResult[]
  fundamentals: FundamentalsStatus
  basis_value: number
  basis_is_reference: boolean
}

export interface DriftRow {
  symbol: string
  kind: 'core' | 'stock' | 'off_plan'
  target_pct: number
  actual_pct: number | null
  diff_pp: number | null
  target_value: number
  actual_value: number | null
  flagged: boolean
  reason: string
}

export interface Holdings {
  drift: DriftRow[]
  portfolio: PortfolioSummary
  freshness: Record<string, Freshness>
}

export interface HoldingInput {
  symbol: string
  shares: number
  avg_cost: number
}

export interface Allocation {
  symbol: string
  amount: number
  shares: number | null
  price: number | null
}

export interface ContributionPlan {
  amount: number
  allocations: Allocation[]
  leftover: number
  note: string
}

export interface ChartPoint {
  day: string
  open: number
  high: number
  low: number
  close: number
  sma50: number | null
  sma200: number | null
}

export type EventKind = 'golden_cross' | 'death_cross' | 'big_up' | 'big_down'

export interface ChartEvent {
  day: string
  kind: EventKind
  price: number
  label: string
  explanation: string
}

export interface Chart {
  symbol: string
  freshness: Freshness
  points: ChartPoint[]
  events: ChartEvent[]
}

export interface Learn {
  glossary: { term: string; definition: string; why_it_matters: string; example?: string }[]
  faq: { q: string; a: string }[]
  links: { title: string; url: string; source: string; kind: string; topic: string; verified_on: string | null }[]
  pending_links: number
}

export type StoneState = 'laid' | 'open' | 'missed' | 'future' | 'before_start'

export interface Stone {
  month: string
  label: string
  state: StoneState
  amount: number
  entries: number
}

export interface Course {
  year: number
  stones: Stone[]
  laid: number
  keystone: boolean
  total: number
}

export interface Wall {
  courses: Course[]
  total: number
  months_laid: number
  current_streak: number
  longest_streak: number
  first_month: string | null
  this_month: string
  this_month_laid: boolean
  keystones: number
  message: string
}

export interface WallEntry {
  id: number
  month: string
  amount: number
  note: string
  created_at: string
}

export interface WallData {
  wall: Wall
  entries: WallEntry[]
}

/** This month in the browser's own time zone, like "2026-10". */
export function localMonth(d: Date = new Date()): string {
  return `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, '0')}`
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

export interface ResearchStatus {
  source: string
  fetched_at: string | null
  generated_at: string | null
  stale: boolean
  reason: string
  last_error: string
}

export interface ResearchResponse {
  status: ResearchStatus
  data: unknown // validated by phone/research.ts parseResearch before use
}

export interface WatchRow {
  symbol: string
  added_at: string
  added_price: number | null
  verdict_at_add: string
  include: boolean
}

const sym = (s: string) => encodeURIComponent(s)

export const api = {
  authStatus: () => request<AuthStatus>('GET', '/api/auth/status'),
  setup: (setup_token: string, username: string, password: string) =>
    request<AuthStatus>('POST', '/api/auth/setup', { setup_token, username, password }),
  login: (username: string, password: string) =>
    request<AuthStatus>('POST', '/api/auth/login', { username, password }),
  logout: () => request<undefined>('POST', '/api/auth/logout'),
  dashboard: () => request<Dashboard>('GET', '/api/dashboard'),
  refreshMarket: () => request<Dashboard>('POST', '/api/market/refresh'),
  plan: () => request<Plan>('GET', '/api/plan'),
  refreshPlan: () => request<Plan>('POST', '/api/plan/refresh'),
  holdings: () => request<Holdings>('GET', '/api/holdings'),
  saveHoldings: (holdings: HoldingInput[]) => request<Holdings>('PUT', '/api/holdings', { holdings }),
  contribution: (amount: number) => request<ContributionPlan>('POST', '/api/contribution', { amount }),
  chart: (symbol: string, days = 730) =>
    request<Chart>('GET', `/api/chart/${encodeURIComponent(symbol)}?days=${String(days)}`),
  learn: () => request<Learn>('GET', '/api/learn'),
  wall: () => request<WallData>('GET', `/api/wall?this_month=${localMonth()}`),
  logContribution: (month: string, amount: number, note = '') =>
    request<WallData>('POST', '/api/contributions', { month, amount, note, this_month: localMonth() }),
  deleteContribution: (id: number) => request<undefined>('DELETE', `/api/contributions/${String(id)}`),
  research: () => request<ResearchResponse>('GET', '/api/research'),
  refreshResearch: () => request<ResearchResponse>('POST', '/api/research/refresh'),
  watchlist: () => request<WatchRow[]>('GET', '/api/watchlist'),
  watchAdd: (symbol: string) => request<WatchRow[]>('PUT', `/api/watchlist/${sym(symbol)}`, {}),
  watchInclude: (symbol: string, include: boolean) => request<WatchRow[]>('PATCH', `/api/watchlist/${sym(symbol)}`, { include }),
  watchRemove: (symbol: string) => request<undefined>('DELETE', `/api/watchlist/${sym(symbol)}`),
}

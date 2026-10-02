# Keystone Ledger: build plan

Status: **Phase 1 done** · Phase 2 next (waiting on the decisions at the bottom).

## Architecture
```
React (Vite, Tailwind, Lightweight Charts, Recharts)
   │  same-origin fetch, httpOnly session cookie + CSRF header
FastAPI ── SecurityMiddleware (Host allowlist, Origin check, CSP/headers, body cap)
   ├── api/       thin routes, Pydantic in/out
   ├── core/      auth, config audit, (P2) engine: indicators → regime → screens → sizing → guardrails
   ├── data/      Provider Protocols → MarketDataService (SQLite cache + freshness)
   └── db/        SQLAlchemy models (SQLite, WAL, 0600)
scheduler (P3): 8:30 ET weekday job → refresh → compute picks → (opt) `claude -p` brief
```
The engine is pure functions: DataFrames in, dataclasses out, no I/O and no clock. That one rule
makes indicators unit-testable against known values and lets the backtester replay history with
no look-ahead, because it only ever passes bars up to day *t*.

## Phase 1: skeleton ✅
- [x] Repo layout, `CLAUDE.md`, README, pinned deps (uv.lock with hashes, exact npm versions)
- [x] Settings (`.env`) vs trading config (TOML, frozen, hard ceilings, audited on change)
- [x] Auth: argon2id, one-time setup token, server-side sessions (hash only), 12h idle / 7d
      absolute, persisted lockout, CSRF, Origin + Host checks, CSP and security headers
- [x] SQLite schema: users, sessions, login attempts, security events, config audit, price bars,
      macro observations, fetch log
- [x] Data: `PriceProvider` / `MacroProvider` interfaces, yfinance + FRED CSV, validation (drop,
      never repair), pacing, incremental cache with overlap re-fetch, dividend/split re-adjust
      detection, failure backoff, NYSE-calendar staleness (holidays and early closes)
- [x] Minimal UI: setup, login, market status with loud stale banner, dark/light, footer note
- [x] `make check` green: 93 pytest, 9 vitest, ruff, mypy --strict, eslint (strict-type-checked),
      tsc, pip-audit, npm audit

## Phase 2: engine
- Universe: S&P 500 list plus config ETFs, with the liquidity filter (price > $10, 20-day ADV > $20M).
  Use a **batched** price download, since ~510 symbols at 1 req/s is ~9 minutes per pass.
- Indicators: SMA/EMA, RSI(14) (Wilder), ATR(14) (Wilder), ATR%, 3-month RS vs SPY and its
  percentile, 200-day slope, crossovers. Each is tested against hand-computed or published values.
- Regime: SPY vs 50/200-day, VIX level and 10-day trend, breadth (% above 200-day) → Green/Yellow/Red,
  with the reason for each.
- Swing screen, with every rule as a named check (pass/fail/unavailable). Stop at 2×ATR, target at
  2R, earnings exclusion, ATR% warn/ceiling.
- Growth screen from SEC EDGAR companyfacts: revenue CAGR, operating-margin level and trend, FCF
  (CFO − capex), debt/equity. A missing metric is "unavailable" and is never scored.
- Sizing: fixed-fractional for swing, equal-weight for growth, floor to whole shares, every cap applied.
- Guardrails: cool-off lock, drawdown brake, position, size and sector caps, Yellow half-size,
  Red no-entry. Each has unit tests.

## Phase 3: UI
Daily dashboard, pick cards with checklists, annotated charts (crossovers, breakouts, stop/target
bands, earnings, RS inflection), paper ledger (fills at next open, stops/targets checked on daily
high/low), performance page, Learn section (glossary, how picks work, FAQ, link-checked
`links.json`), and the 8:30 ET weekday scheduler with cron, launchd and Task Scheduler instructions.

## Phase 4: proof
10+ year backtest (commissions, slippage, no look-ahead, survivorship caveat in the UI), case
studies (MSFT, NKE, plus one winner and one faller, signals circled with a hindsight disclaimer),
go-live readiness card (30 sessions, risk-adjusted vs SPY, honest either way), Tailscale access,
and an optional `claude -p` brief that gets market data and pick metrics only, never balances.

## Risks and where I'd push back
1. **Yahoo is the weakest link.** It's free and keyless, but unofficial, personal-use, and
   rate-limited without warning. Mitigations: provider interface, aggressive cache, pacing, and
   stale flags. If it degrades, the cleanest free fallback is Stooq, which now needs a free
   CAPTCHA key.
2. **Survivorship bias.** Today's S&P 500 list makes any 10-year backtest look better than reality.
   A free, keyless, community-maintained dataset of historical S&P 500 membership exists (GitHub:
   `fja05680/sp500`). I recommend using it for the backtest universe and still showing the caveat.
3. **Forward earnings dates are the shakiest free data.** yfinance's earnings calendar is often
   empty or wrong. Recommendation: if the next earnings date is **unknown**, treat it as "inside
   the window" and exclude the swing entry. Missing data fails safe, never open.
4. **Sector caps need sectors.** Use the GICS sector column from the S&P 500 constituents list
   (free) rather than yfinance `info`, which is slow and rate-limited.
5. **1% risk on a 25% sleeve.** With $10k, a 1% risk ($100) and a tight stop can reach the 10%
   position cap ($1,000) quickly, so many picks will be cap-bound rather than risk-bound. The UI
   will show which constraint bound each size.

## Decisions needed before Phase 2
- [ ] OK to use the `fja05680/sp500` historical-constituents CSV (free, no key) for the universe/backtest?
- [ ] Earnings date unknown → exclude swing entry (my recommendation) or warn only?
- [ ] Get a Stooq key as a backup price source, or stay keyless (yfinance only) for now?
- [ ] Your SEC User-Agent contact string for `.env` (EDGAR requires one).

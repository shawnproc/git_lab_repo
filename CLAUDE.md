# Keystone Ledger: conventions for Claude Code

A personal, single-user, long-term investing dashboard: a local PC app plus an iPhone web app
(GitHub Pages, data on the phone). Educational, not advice.
The full build plan and phase status are in `docs/PLAN.md`. Read it before starting a phase.

## Non-negotiables
- **Never fabricate data.** Every number shown comes from a fetched source and carries `source` +
  `fetched_at` + `last_day`. Missing or stale data is flagged (`Freshness.stale`) and shown loudly.
  Never forward-fill, interpolate or "repair" prices (`yfinance` runs with `repair=False`).
- **Guardrails are code, not UI.** Limits live in `config.py` (`HARD_MAX_*`) and schema validators
  (no stock above 10%; targets always sum to 100%). Config is frozen at startup and no API writes
  it. Every config change is audited (`config_audit`). Don't add runtime setters for plan settings.
- **Scope.** Long-term plan only: mood, plan, contribution, holdings/drift, charts, Learn. No swing
  trading, backtests, auto-trading or broker connections.
- **No paid services, no keys without asking.** Ask the owner before adding any dependency that
  needs an account, API key or payment.
- **iPhone app (GitHub Pages):** `vite build --mode phone` + `tools/snapshot.py` in the daily
  workflow. The snapshot is PUBLIC: market mood, plan picks, Learn links, never personal data.
  Holdings and the wall live only in the phone's local storage (`frontend/src/phone/store.ts`,
  validated on load and restore). Phone math in `phone/logic.ts` mirrors the Python engine, and
  the tests use the same numbers; change both together. `phone/portfolio.ts` (shares x closes,
  chart ranges) is phone-only and pure.
- **Security first.** Bind 127.0.0.1. No CORS middleware (same-origin only). Every state-changing
  authenticated endpoint uses `CsrfPrincipalDep`. Use Pydantic models with `extra="forbid"` for
  every request body. ORM or parameterized SQL only. No `eval`/`exec`/`pickle` on fetched data.
  Never log secrets, cookies, CSRF tokens or API keys (`core/logging.py` redacts as a backstop).

## Layout
```
backend/src/keystone_ledger/
  settings.py        env/.env deployment knobs (KL_*)
  config.py          plan rules (TOML), frozen + hard ceilings
  app.py, serve.py   app factory; entry point (loopback check, setup token)
  api/               routes_*.py, deps.py (auth/CSRF deps), security.py (ASGI middleware)
  core/              auth.py, config_audit.py, logging.py; pure engine: mood.py, screen.py,
                     plan.py (targets, drift, contribution), chart.py (SMA, crossovers, big moves)
  planner.py         glue: reads caches, calls the pure engine (no provider calls unless `refresh*`)
  learn.py           validates content/learn.json
  data/              base.py (Protocols + validation), *_provider.py, service.py (price cache),
                     fundamentals.py (SEC cache), sec_provider.py (EDGAR frames API)
  db/                models.py (SQLAlchemy), session.py, types.py (UTCDateTime)
  core/wall.py       the growing wall (contribution log -> stones, streaks, keystones); pure
backend/tests/       pytest; fakes in conftest.py, no network in tests
frontend/src/        React + TS + Tailwind v4; api.ts is the only fetch() caller; pages/ (Home, Plan,
                     Money, Charts, Learn); components/ui.tsx (Explain, StaleBanner, ...)
config/              keystone.example.toml (must equal defaults; a test enforces it)
content/learn.json   glossary, FAQ, links (https only, each verified before adding)
```

## Conventions
- Python 3.12, `uv`, deps **pinned exactly** in `pyproject.toml` + `uv.lock`; npm `--save-exact`.
- Datetimes are timezone-aware UTC everywhere (`UTCDateTime` rejects naive values).
  Market dates are `datetime.date` in exchange-local (NY) terms; use `data/calendar.py`, never
  weekday math, for sessions, holidays and early closes.
- New data source = a class satisfying `PriceProvider` / `MacroProvider` + a branch in
  `data/registry.py` + tests with a fake transport. Pace requests with `MinIntervalLimiter`.
- SQLite: never hold a write in the request session while calling a provider (use
  `transaction(...)` and commit first); the auth dependency touches sessions in its own transaction.
- Engine code (core/mood, screen, plan, chart) is pure functions: no I/O, no clock reads, so it's
  testable against known values; chart events use only data up to each day (no look-ahead).
- Tests: no network. Use the fakes in `conftest.py` (`FakeClock`, `FakePriceProvider`,
  `FakeMacroProvider`, `FakeFundamentalsProvider`).
- **Write for a beginner.** Every user-facing string is plain English: say what a term means the
  first time, prefer "$1 of sales keeps 44¢" to "44% operating margin", and pair each screen with an
  `Explain` box. Never imply a buy/sell instruction from mood or chart events.
- **Visual identity (keep it):** two themes, Blueprint (dark, default) and Ledger (light), defined
  as CSS tokens in `frontend/src/index.css`. Masonry motifs live in `components/brand.tsx` (keystone
  tabs, mood arch, foundation wall, spirit level, stone icons) and `components/GrowingWall.tsx`. Fonts are self-hosted via
  @fontsource (Fraunces, IBM Plex Sans/Mono); never load fonts or assets from a CDN (CSP).
  Chart colors are validated with the dataviz palette validator for both surfaces; re-run it
  after any change, and keep shape (arrows vs circles) as a second cue beside color.
- `tasks.ps1` must stay plain ASCII and Windows PowerShell 5.1 compatible (no `&&`, `??`, ternary).
- Keep commits small, with imperative messages.

## Commands
`make install` · `make run` (build UI + serve :8787) · `make dev` (API :8787 + Vite :5173) ·
`make check` (ruff, mypy --strict, eslint, tsc, pytest, vitest, pip-audit, npm audit).
The owner is on Windows: keep `tasks.ps1` in sync with the Makefile and avoid POSIX-only code paths.

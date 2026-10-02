# Keystone Ledger: conventions for Claude Code

A personal, single-user, **paper-first** stock decision aid. Local only. Educational, not advice.
The full build plan and phase status are in `docs/PLAN.md`. Read it before starting a phase.

## Non-negotiables
- **Never fabricate data.** Every number shown comes from a fetched source and carries `source` +
  `fetched_at` + `last_day`. Missing or stale data is flagged (`Freshness.stale`) and shown loudly.
  Never forward-fill, interpolate or "repair" prices (`yfinance` runs with `repair=False`).
- **Guardrails are code, not UI.** Risk ceilings live in `config.py` (`HARD_MAX_*`) and in schema
  validators. Config is frozen at startup, and no API writes it. Every config change is audited
  (`config_audit`). Don't add a runtime setter for any risk parameter.
- **No paid services, no keys without asking.** Ask the owner before adding any dependency that
  needs an account, API key or payment.
- **Security first.** Bind 127.0.0.1. No CORS middleware (same-origin only). Every state-changing
  authenticated endpoint uses `CsrfPrincipalDep`. Use Pydantic models with `extra="forbid"` for
  every request body. ORM or parameterized SQL only. No `eval`/`exec`/`pickle` on fetched data.
  Never log secrets, cookies, CSRF tokens or API keys (`core/logging.py` redacts as a backstop).

## Layout
```
backend/src/keystone_ledger/
  settings.py        env/.env deployment knobs (KL_*)
  config.py          trading rules (TOML), frozen + hard ceilings
  app.py, serve.py   app factory; entry point (loopback check, setup token)
  api/               routes_*.py, deps.py (auth/CSRF deps), security.py (ASGI middleware)
  core/              auth.py (argon2id, sessions, lockout), config_audit.py, logging.py
  data/              base.py (provider Protocols + validation), *_provider.py, service.py (cache)
  db/                models.py (SQLAlchemy), session.py, types.py (UTCDateTime)
backend/tests/       pytest; fakes in conftest.py, no network in tests
frontend/src/        React + TS + Tailwind v4; api.ts is the only fetch() caller
config/              keystone.example.toml (must equal defaults; a test enforces it)
```

## Conventions
- Python 3.12, `uv`, deps **pinned exactly** in `pyproject.toml` + `uv.lock`; npm `--save-exact`.
- Datetimes are timezone-aware UTC everywhere (`UTCDateTime` rejects naive values).
  Market dates are `datetime.date` in exchange-local (NY) terms; use `data/calendar.py`, never
  weekday math, for sessions, holidays and early closes.
- New data source = a class satisfying `PriceProvider` / `MacroProvider` + a branch in
  `data/registry.py` + tests with a fake transport. Pace requests with `MinIntervalLimiter`.
- Indicators/engine (Phase 2+) are pure functions on DataFrames: no I/O, no clock reads, so
  they're testable against known values and safe for backtests (no look-ahead).
- Tests: no network. Use `FakeClock`, `FakePriceProvider` and `FakeMacroProvider` from `conftest.py`.
- Keep commits small, with imperative messages.

## Commands
`make install` · `make run` (build UI + serve :8787) · `make dev` (API :8787 + Vite :5173) ·
`make check` (ruff, mypy --strict, eslint, tsc, pytest, vitest, pip-audit, npm audit)

# Keystone Ledger

A personal long-term investing dashboard: market mood, a core-plus-quality-stocks plan, a monthly
contribution split, holdings drift, annotated charts and a Learn page. It runs entirely on your
machine and uses free data only.

> **Educational tool, not financial advice.** It never connects to a broker or places trades.

**Status:** the backend is complete. The new UI pages and Windows scripts are next; see
[`docs/PLAN.md`](docs/PLAN.md).

## Requirements
- Python 3.12 + [uv](https://docs.astral.sh/uv/)
- Node.js 22+
- `make` (on Windows, use WSL, or run the commands inside the `Makefile` by hand)

## Setup
```bash
make install                 # pinned deps from uv.lock / package-lock.json
cp .env.example .env         # optional: deployment settings (all have safe defaults)
cp config/keystone.example.toml config/keystone.toml   # optional: trading rules
make run                     # builds the UI, serves http://127.0.0.1:8787
```
On first run, the terminal prints a **one-time setup token**, which is also saved to
`var/setup-token.txt` with mode 0600. Open the app, paste the token, and choose a username and a
passphrase of 12+ characters. The token is deleted once the account exists. It stops any other local
process or web page from claiming your account first.

For UI work, run `make dev`: the API runs on :8787 and Vite hot-reloads on :5173, proxying `/api`.

## Daily use (Phase 1)
Sign in, then click **Refresh data**. The dashboard shows the SPY close and VIX, each with its
source, the session it's from, the session it *should* be from, and when it was fetched. If anything
is missing or behind, a yellow banner says so. Don't act on numbers flagged stale.

## Changing config
Trading rules live in `config/keystone.toml` (start from `config/keystone.example.toml`).
- Read **once at startup**, so restart to apply changes. No setting can be changed from the UI.
- Hard limits are enforced in code: no single stock above **10%**, 1-3 core funds whose weights add
  up to the core %, and core + stocks = 100%. A file that breaks them refuses to load.
- Every change is logged with a diff in the `config_audit` table, viewable at `GET /api/config`.

Deployment settings (port, session timeouts, lockout) are `KL_*` variables in `.env`.

## Data sources (verified October 2026)
| Data | Source | Key? | Notes |
|---|---|---|---|
| Daily OHLCV | Yahoo Finance via `yfinance` 1.7 | No | Personal use only. No published quota, and rate limits are aggressive (`YFRateLimitError`). We pace to ≤1 req/s, fetch incrementally and cache in SQLite. |
| VIX (VIXCLS) | FRED `fredgraph.csv` | No | FRED's JSON API needs a free key (account required). The CSV export doesn't. Data is Cboe's: personal use. |
| Fundamentals | SEC EDGAR frames API | No | Max 10 req/s (we use 5), and you **must** send a User-Agent with your contact info (`KL_SEC_USER_AGENT`). |

Sources sit behind `PriceProvider` / `MacroProvider` interfaces (`backend/src/keystone_ledger/data/base.py`),
so you can swap one by changing `[data]` in the config.

## Security model
- Binds to **127.0.0.1 only**. Any other address is refused unless explicitly allowed. For phone
  access, use Tailscale rather than opening a port.
- argon2id password hashing. Server-side sessions store only a SHA-256 of the token. The cookie is
  `HttpOnly; SameSite=Strict` (plus `Secure` over HTTPS). Sessions expire after 12 hours idle and
  7 days absolute. Five failed logins in 15 minutes lock login for 15 minutes, and the lockout
  survives restarts.
- Per-session CSRF token on every state-changing request, plus Origin/`Sec-Fetch-Site` checks. No
  CORS headers, so the API is same-origin only.
- Host-header allowlist blocks DNS rebinding. Responses carry a strict CSP, `X-Frame-Options: DENY`,
  `nosniff`, `no-referrer` and `no-store`. Request bodies are capped at 64 KB.
- Pydantic validation (`extra="forbid"`) on every input. ORM-only SQL. Symbols are regex-validated
  before they reach a provider. Logs pass through a redaction filter. The DB file is 0600.
- `make check` runs `pip-audit` (against the hash-pinned lock) and `npm audit`.

## Development
```bash
make check   # ruff + mypy --strict + eslint + tsc + pytest + vitest + pip-audit + npm audit
make fmt
```

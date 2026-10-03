# Keystone Ledger: plan (rescoped October 2026)

A long-term investing dashboard: market mood, a core-plus-quality-stocks plan, monthly
contribution split, holdings drift, annotated charts and a Learn page. Local, single user, free
data, educational only.

## Status
- [x] **Phase 1, skeleton:** auth, security middleware, data layer (yfinance, FRED), UI shell
- [x] **Checkpoint 1, backend:** config, SEC fundamentals, engine, holdings, API, tests
- [x] **Checkpoint 2, frontend:** Home, My Plan, My Money, Charts, Learn pages, all written for
      a beginner with "What does this mean?" explainers. `tasks.ps1` for Windows (tested in
      PowerShell 7.5) and a step-by-step Windows README.
- **Links:** `content/learn.json` links are shown only after `verify-links` confirms they open.
  Setup runs it automatically. The sandbox couldn't reach the sites, so the links were chosen
  from current search results and are stamped on the owner's machine.

- [x] **The growing wall:** log each month you invest; one stone per month, a row per year,
      a keystone for a full year, current and best streaks. The numbers are the owner's own
      entries, never fetched.

- [x] **iPhone app:** installable from Safari, works offline, no login. A daily GitHub Actions job
      builds a public snapshot (FRED S&P 500 + VIX for mood with Yahoo as a backup, each plan
      ticker's last close from Yahoo, SEC for the plan, link checks) and publishes it with the app
      to GitHub Pages. Each run writes a status table to the Actions run page. Holdings are typed in from the broker app; the
      split is in dollars; holdings and the wall stay on the phone, with backup and restore.
      Charts stay in the PC app. If Yahoo blocks GitHub's servers, prices show "no price today"
      and the app still works from the typed-in values.

## Rules (all in `config/keystone.toml`)
| Feature | Rule |
|---|---|
| Market mood | 🟢 S&P 500 above its 200-day average **and** VIX < 20 · 🔴 below **and** VIX > 30 · 🟡 otherwise · "unknown" without 200 days of data or a VIX reading |
| Plan | 60% core (VTI 45 / VXUS 15) + 40% split equally across up to 6 screened stocks, max 2 per sector, max 8% each (hard cap 10%). Unused stock weight goes to core. |
| Screen (SEC EDGAR) | Revenue growth ≥ 5%/yr over 3 yrs · operating margin ≥ 12% · margin not down > 1 pt vs 2 yrs ago · free cash flow > 0 · long-term debt ≤ 3 years of operating profit. Qualify with no fails and ≤ 1 "unavailable"; rank by growth + margin. |
| Contribution | New money goes to the most underweight holdings first, never sells. Fractional shares by default; whole-share mode floors each buy and spends the leftover one share at a time. |
| Drift | Flag when > 5 points off target **or** > 25% off the holding's own target; anything not in the plan is "off-plan". |
| Charts | Price + 50/200-day lines. Golden/death crosses; big moves = ≥ 3x the prior 20-day typical move and ≥ 3%. Uses only past data. |

## Data
- **Prices:** yfinance (no key, personal use, rate-limited, so paced and cached).
- **VIX:** FRED `fredgraph.csv` (no key).
- **Fundamentals:** SEC EDGAR **frames** API (no key; ≤ 10 req/s, User-Agent with contact required).
  About 50 requests per refresh cover all 40 candidates. Cached for 30 days.
- **Known limits:**
  - Debt uses `LongTermDebt`/`LongTermDebtNoncurrent`, so companies that file debt under other
    tags show "unavailable".
  - Frames map non-calendar fiscal years to the closest calendar year.

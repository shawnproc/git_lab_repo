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
      to GitHub Pages. Each run writes a status table to the Actions run page.
      The snapshot carries about a year of daily closes for every ticker on the public company
      list, so Today shows "Your money" (your shares x each day's close, 1W to 1Y, with a finger
      scrub) and each ticker opens its own chart. Gaps stay gaps; nothing is filled in.
- [x] **Today's move (buy schedule):** the owner sets a cadence (weekly, every 2 weeks, twice a
      month, monthly) and an amount, stored on the phone (`phone/schedule.ts`). On a buy day the
      card shows the contribution split (most underweight first, never sells) with share
      estimates; otherwise a countdown. Buy days come from the schedule, never from prices or
      mood: steady buying beats timing. Tickers show "% below 1-yr high" as context only.
- [x] **Sleeve vs. index:** the stock sleeve's real result vs a shadow that put the same dollars
      into VTI on the same days (`phone/sleeve.ts`); funds/stocks split 60/40, 70/30 or 80/20 as a
      phone setting (`targetsFor`, mirror of `build_targets` with affinity weights and the cap).
      Overlap: VTI's published top holdings give each company's combined weight.
- [x] **No churn, with a price check:** quarterly check-ins recorded in the snapshot
      (`core/watch.py`): 1 failure = on watch, 2 in a row = replace (new money stops; never sells).
      Last quarter's picks stay picked unless replaced. P/E vs its own 5-year median of year-end
      P/Es (SEC diluted EPS + year-end closes, `core/valuation.py`); above 1.5x flags it and
      buy-day money skips it. Affinity weights the sleeve by quality and quarterly trend.
- [x] **Never stale as current:** the snapshot is validated before publishing
      (`tools/validate_snapshot.py`); on failure the last good file stays and `status.json` says
      why. The snapshot carries market sessions with close times; the phone counts market days
      behind and hides buy amounts past one. Mood is display-only (tests assert it).
- [x] **Locked backup:** PBKDF2-SHA-256 (600k) + AES-256-GCM with an authenticated header
      (`phone/backup.ts`); restore verifies, previews, and needs an explicit replace; monthly
      reminder on Today.
- [x] **Robinhood import (no API, no keys):** the phone reads Robinhood's account activity CSV
      locally (`phone/robinhood.ts`). Buy/Sell/SPL/REC/ACATI change shares; cash codes are skipped;
      unknown codes and options are reported, never guessed. Real history = shares held each day x
      split-adjusted close, with each trade scaled by later splits (the snapshot carries split
      ratios). The chart separates money added from market movement. Live broker APIs (SnapTrade,
      Plaid) were considered and deferred: they need an account and keys, and the phone can't hold
      a secret. Holdings are typed in from the broker app; the
      split is in dollars; holdings and the wall stay on the phone, with backup and restore.
      Charts stay in the PC app. If Yahoo blocks GitHub's servers, prices show "no price today"
      and the app still works from the typed-in values.
- [x] **Search, watchlist, live prices:** the daily job also writes `research.json` (public):
      every SEC filer with at least `research_min_revenue_usd` (default $1B) of latest yearly
      sales, screened with the plan's checks (`core/research.py` judge: fit / pricey / no /
      unknown; funds price-only), with one batched daily Yahoo request per ticker
      (`fetch_batch`, 6 years: quote, dividends, splits, year-end closes). Split-safe P/E: only
      year-ends after the last split; a split after the latest annual report makes the check
      wait. Validated (`validate_research`); on failure the last good file stays and
      `status.json["research"]` says why; it never blocks the snapshot. Phone: Search tab
      (`phone/research.ts`, `Search.tsx`), watchlist in PhoneData (validated, in backups),
      "Include in my buy days" for current Good fits only (max 5, through `buildTargets` and its
      cap; never on an old verdict). Live prices: Finnhub `/quote` with the owner's own key,
      stored only in localStorage `keystone.live.v1` (`phone/live.ts`), CSP allows only
      `https://finnhub.io`; display only, never an input to buy math.

## Rules (all in `config/keystone.toml`)
| Feature | Rule |
|---|---|
| Market mood | 🟢 S&P 500 above its 200-day average **and** VIX < 20 · 🔴 below **and** VIX > 30 · 🟡 otherwise · "unknown" without 200 days of data or a VIX reading |
| Plan | 60% core (VTI 45 / VXUS 15) + 40% split equally across up to 10 screened stocks (4% each), max 2 per sector, max 8% each (hard cap 10%). Unused stock weight goes to core. |
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

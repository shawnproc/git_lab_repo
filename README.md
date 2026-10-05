# Keystone Ledger

A personal long-term investing dashboard that runs on your own computer:

- **Home:** today's market mood (🟢 🟡 🔴) and how your money is doing.
- **My Plan:** what to own (a steady core of index funds plus up to 10 strong companies), how much
  of each, and why.
- **My Money:** enter what you own, see whether you're on track, get a split for this month's
  money, and lay this month's stone on **your wall**. It grows by one stone for every month you
  invest, and a full year earns a keystone.
- **Charts:** prices with trend lines, with the important moments circled and explained (PC app).
- **Learn:** every word the app uses, in plain English, plus beginner questions answered.

> **Educational tool, not financial advice.** It never connects to a broker or places trades.
> Free public data only. Everything stays on your computer.

---

## On your iPhone (no PC needed) ⭐

The iPhone app is a web app you add to your Home Screen. Every weekday evening GitHub refreshes
the market mood and your plan by itself (free), so your PC doesn't need to be on. Your holdings
and your wall are saved **only on your phone**.

### One-time setup (about 10 minutes, on a computer)
1. **Merge this work into `main`.** On GitHub, open the pull request for branch
   `claude/new-session-l8c0p3` and click **Merge**. (GitHub only runs scheduled jobs from `main`.)
2. **Make the repository public.** Repository → **Settings** → **General** → scroll to
   **Danger Zone** → **Change visibility** → **Public**. (No passwords or personal data are in it.)
3. **Turn on the website.** **Settings** → **Pages** → under *Build and deployment*, set
   **Source** to **GitHub Actions**.
4. **Add your SEC contact as a secret.** **Settings** → **Secrets and variables** → **Actions** →
   **New repository secret**. Name: `SEC_USER_AGENT`. Value: your name and email, for example
   `Jane Smith jane@example.com`. Secrets are hidden, even in a public repository.
5. **Run it the first time.** **Actions** tab → **Daily data + iPhone app** → **Run workflow**.
   Wait for the green check (about 3 minutes). Click the run to see a **Today's snapshot** table:
   ✅ or ⚠️ for the market mood, ticker prices and company reports, with the reason for any ⚠️.

### Put it on your Home Screen
1. On your iPhone, open **Safari** and go to `https://<your-github-name>.github.io/<repo-name>/`
   (for this repo: **https://shawnproc.github.io/git_lab_repo/**).
2. Tap the **Share** button (the square with an arrow) → **Add to Home Screen** → **Add**.
3. Open **Keystone** from your Home Screen. It opens full-screen, like an app.

### Bring in your Robinhood history (once, then whenever you like)
1. In the Robinhood app: **Account** → **Menu** → **Reports and statements** → **Reports** →
   **Generate new report**. Pick your investing account and a start date from when you opened it.
2. Robinhood builds it in about 2 hours (up to a day). Download it to Files.
3. In Keystone: **Invest** → **Import from Robinhood** → **Choose the report file** → check the
   shares → **Use these**.

The file is read on your phone and never uploaded. You get your real shares, your real account
history on the **Today** chart (with "you added $X · the market moved $Y"), and a stone on your wall
for every month you bought.

### What the app watches for you
- **3 to put new money in** (Today): the companies to favor right now, ranked by business
  strength from SEC reports, which way each is heading since last quarter, a price check, and how
  far behind target each is. It changes as companies grow or weaken, never on daily price wiggles.
- **Your picks vs. just VTI** (Today): your individual stocks against a pretend account that put
  the same dollars into VTI on the same days. If the index keeps winning, pick a bigger fund share.
- **Your mix** (Plan): 60/40, 70/30 or 80/20 between the index funds and the companies.
- **Company check-ins** (Plan): one failed quarterly check = on watch; two in a row = replaced
  (new money stops; the app never tells you to sell). A company priced well above its own usual
  price-to-earnings level gets no new money until that cools off.
- **What VTI already owns** (Plan): your real stake in each company, direct plus inside VTI.
- **Never old numbers as new:** Today shows "Prices as of …". If prices are more than one market
  day old, or the daily update failed its safety checks, buy amounts are hidden until fresh data
  arrives. The daily job checks every snapshot before publishing and keeps the last good one if
  anything looks wrong.
- **Locked backup** (Wall): one file sealed with your passphrase (AES-256). Save it to iCloud
  Drive or a USB thumb drive. Today reminds you every 30 days.
- **Search** (Search tab): type a company or ticker (Apple, AAPL) to see its price, yearly sales,
  dividend, a price check and the plan's 5 quality checks, with a verdict: **Good fit**, **Good
  business, pricey right now** or **Not a fit**. Covers every US company with over $1 billion in
  yearly sales, rebuilt every weekday evening. Verdicts measure a company against the plan's
  rules; they are not predictions or advice.
- **Watchlist** (Search tab): save any company to follow it: price since you saved it, and a
  note when its verdict changes. Switch on **Include in my buy days** for a Good fit (up to 5) and
  it joins your stocks, under the same per-company limit. If it stops being a Good fit it's paused
  by itself (no new money; nothing is ever sold). The watchlist is on the phone and in backups.
- **Live prices (optional):** get a free key at [finnhub.io](https://finnhub.io/register) and
  paste it in Search → Live prices. Search and your watchlist then show the price right now,
  refreshed every minute while the app is open. The key stays on that phone only (not in the
  code, the public data or backups). Buy amounts always use the last close.

### Your buy-day routine (about 2 minutes)
Open **Today**. The **Today's move** card shows whether today is a buy day (you set your schedule
once: weekly, every 2 weeks, twice a month or monthly, and the dollars each time). On a buy day it
lists exactly what to buy, in dollars, across the funds and up to 10 companies. Buy those in your
broker app, then tap **I bought these. Lay the stone**. On other days it shows the countdown to
your next buy day: nothing to do. Each ticker also shows how far it is below its 1-year high, as
context only (it never changes the amounts).

Or, the long way: **Invest** tab → type how many **shares** you own of each (from your broker app; only when they
change) → **Split it** → buy those dollar amounts in your broker app → **Lay the stone**. The
**Today** tab then shows your money as a chart (1W to 1Y), priced at each weekday's close. Every few months: **Wall** tab → **Save a backup**
→ save it to Files or iCloud Drive.

> Changing your plan (the 60/40 split, the company list, and so on): edit
> `config/keystone.toml` on GitHub (copy it from `config/keystone.example.toml` the first time).
> The next daily run uses it.

## Setting it up on Windows (step by step, about 15 minutes)

You only do this once. Each step says what to type; copy and paste it exactly.

### 1. Open PowerShell
Press the **Windows key**, type `PowerShell`, and click **Windows PowerShell**. A blue or black
window opens. That's where you'll type the commands below.

### 2. Install the three free tools the app needs
Paste each line, press **Enter**, and wait for it to finish before the next one. If Windows asks
"Do you want to allow this app to make changes?", click **Yes**.

```powershell
winget install --id Git.Git -e
winget install --id OpenJS.NodeJS.LTS -e
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
```

- **Git** downloads the app's code.
- **Node.js** builds the app's screens.
- **uv** runs the app's engine (it installs the right Python for you).

**Now close PowerShell and open a new one** so Windows notices the new tools.

> If `winget` isn't recognized, install **App Installer** from the Microsoft Store, or download
> Git from https://git-scm.com and Node.js (the "LTS" version) from https://nodejs.org.

### 3. Allow PowerShell to run the app's script (one time)
Windows blocks scripts by default. This allows scripts you create or download with tools like Git:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

Type `Y` and press **Enter** if it asks.

### 4. Download the app
```powershell
cd $HOME\Documents
git clone https://github.com/shawnproc/git_lab_repo.git KeystoneLedger
cd KeystoneLedger
git checkout claude/new-session-l8c0p3
```

If a GitHub sign-in window pops up, sign in with your GitHub account (needed if the repository is private).

### 5. Run the one-time setup
```powershell
.\tasks.ps1 setup
```

It installs everything (exact, security-checked versions), builds the screens, and checks that the
Learn page links open. It also asks for **your name and email**: the SEC (the government office
that publishes company reports) asks every app to say who is reading. They're saved only in a file
called `.env` on your computer.

### 6. Start the app
```powershell
.\tasks.ps1 run
```

Leave this window open while you use the app. Then open your browser and go to
**http://127.0.0.1:8787**. (That address means "this computer"; the app is never on the internet.)

**The very first time**, the PowerShell window prints a **setup token**, a one-time code, that
looks like `pxvxEkzl5zSjC9PRWNiJzy_tVnKnBAXq`. Copy it into the browser page, then pick a username
and a password of 12+ characters (a short sentence works well). This step means nobody else on
your computer can create the account before you.

To stop the app, click the PowerShell window and press **Ctrl + C**.

---

## Your monthly routine (about 10 minutes)
1. Run `.\tasks.ps1 run` and open **http://127.0.0.1:8787**.
2. **Home** → click **Refresh prices**. Read the mood. Whatever the color, the plan is usually
   the same: keep adding on schedule.
3. **My Plan** → click **Update company reports** (it only re-reads them about once a month).
4. **My Money** → type in this month's amount and click **Show me how to split it**.
5. Place those buys in your broker's app.
6. Back on **My Money**, click **I invested … Lay this month's stone**, then update your shares
   and click **Save**.

Every screen has **💡 What does this mean?** boxes. Click them any time.

---

## Changing the plan
The rules live in a settings file. To change them:

1. Copy `config\keystone.example.toml` to `config\keystone.toml`.
2. Open it in Notepad. Every setting has a comment explaining it.
3. Save it, then restart the app (Ctrl + C, then `.\tasks.ps1 run`).

Examples: change the 60/40 split, add a bond fund like BND to the core, switch to whole shares
(`fractional_shares = false`), or edit the list of 40 companies.

Built-in safety limits that can't be turned off: no single company above **10%** of your money,
the core funds must add up to the core %, and core + companies must equal 100%. A settings file
that breaks these refuses to load and tells you why. Every change is recorded.

---

## If something goes wrong
| What you see | What to do |
|---|---|
| `.\tasks.ps1 : cannot be loaded because running scripts is disabled` | Do step 3 again. |
| `Missing: uv` (or node) | Do step 2 again, then **close and reopen** PowerShell. |
| The browser says "can't reach this page" | The app isn't running: run `.\tasks.ps1 run` and keep that window open. |
| A yellow "**numbers are old or missing**" banner | The free data source is slow or limiting requests. Click **Refresh prices** again in a few minutes. Don't act on old numbers. |
| "Too many failed attempts" at sign-in | Wait 15 minutes, then try again. |
| Learn page says links are "waiting to be checked" | Run `.\tasks.ps1 verify-links` while connected to the internet. |

---

## Where the numbers come from (all free, no accounts)
| Data | Source | Notes |
|---|---|---|
| Daily prices | Yahoo Finance via `yfinance` | Personal use. Requests are paced and saved, so the app asks rarely. |
| VIX (fear gauge) | FRED (St. Louis Fed) CSV download | No key needed. |
| Live prices (optional) | Finnhub free plan, your own key | Phone only, for looking: 60 lookups a minute; the app uses at most about 25. |
| Company reports | SEC EDGAR | Free. Requires your name/email (set during setup). At most 5 requests a second (the SEC allows 10). |

If any number is old or missing, the app says so loudly instead of guessing.

## Security, briefly
- Runs only on `127.0.0.1` (your computer). Nothing is reachable from the internet.
- Password stored with argon2id (a slow, salted hash), so even the database file doesn't reveal it.
  Login locks for 15 minutes after 5 wrong tries. You're signed out after 12 hours idle.
- Protections against malicious websites poking at the app: CSRF tokens, strict same-site
  cookies, origin and host checks, and a strict content security policy.
- Your data lives in `%LOCALAPPDATA%\KeystoneLedger`, which only your Windows account can read.
- `.\tasks.ps1 check` runs every test plus a vulnerability scan of every dependency.

## For developers
`.\tasks.ps1 check` (Windows) or `make check` (macOS/Linux) runs ruff, mypy --strict, eslint, tsc,
pytest, vitest, pip-audit and npm audit. `.\tasks.ps1 dev` gives live reload. Conventions are in
[`CLAUDE.md`](CLAUDE.md); the rules and status are in [`docs/PLAN.md`](docs/PLAN.md).

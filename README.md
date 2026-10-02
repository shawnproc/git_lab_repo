# Keystone Ledger

A personal long-term investing dashboard that runs on your own computer:

- **Home:** today's market mood (🟢 🟡 🔴) and how your money is doing.
- **My Plan:** what to own (a steady core of index funds plus up to 6 strong companies), how much
  of each, and why.
- **My Money:** enter what you own, see whether you're on track, and get a split for this month's
  money.
- **Charts:** prices with trend lines, with the important moments circled and explained.
- **Learn:** every word the app uses, in plain English, plus beginner questions answered.

> **Educational tool, not financial advice.** It never connects to a broker or places trades.
> Free public data only. Everything stays on your computer.

---

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
6. Back on **My Money**, update your shares and click **Save**.

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

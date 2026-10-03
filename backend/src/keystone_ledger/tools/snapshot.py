"""Build the daily snapshot for the iPhone app: `python -m keystone_ledger.tools.snapshot`.

Runs on a schedule in GitHub Actions. The snapshot holds ONLY public data: market mood (FRED's
S&P 500 and VIX series, with Yahoo as a backup), the last close of each plan ticker (Yahoo), the
plan picks (SEC filings), and the Learn page (links that open).
Nothing personal ever goes in it; holdings and the wall stay on the phone.

Never fabricate: if a source fails, the previous snapshot's section is carried over, marked
stale with the error, so the phone shows old numbers loudly instead of invented ones.
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import os
import sys
from dataclasses import asdict, is_dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
import pandas as pd

from keystone_ledger import __version__
from keystone_ledger.config import AppConfig, load_config
from keystone_ledger.core.auth import Clock, utcnow
from keystone_ledger.core.mood import market_mood
from keystone_ledger.core.plan import build_targets
from keystone_ledger.data.base import (
    MacroProvider,
    PriceProvider,
    ProviderError,
    validate_bars,
    validate_series,
)
from keystone_ledger.data.calendar import MarketCalendar
from keystone_ledger.data.fundamentals import FundamentalsProvider, FundamentalsService
from keystone_ledger.data.ratelimit import MinIntervalLimiter
from keystone_ledger.db.session import init_schema, make_engine, make_session_factory
from keystone_ledger.learn import for_display, load_learn
from keystone_ledger.planner import run_screen
from keystone_ledger.settings import REPO_ROOT

log = logging.getLogger("keystone_ledger.snapshot")

SCHEMA = 1
INDEX_SERIES = "SP500"  # FRED: S&P 500 daily close (10-year window)
VIX_SERIES = "VIXCLS"
HISTORY_DAYS = 500  # comfortably more than 200 trading days
FRED_LAG_SESSIONS = 1  # FRED posts daily series about one session behind
YAHOO_INDEX = "^GSPC"
YAHOO_VIX = "^VIX"
HISTORY_CHART_DAYS = 370  # a year of daily closes for the phone's charts, plus a margin


def _jsonable(obj: Any) -> Any:
    if is_dataclass(obj) and not isinstance(obj, type):
        return _jsonable(asdict(obj))
    if isinstance(obj, dict):
        return {str(k): _jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_jsonable(v) for v in obj]
    if isinstance(obj, (date, datetime)):
        return obj.isoformat()
    if isinstance(obj, float) and math.isnan(obj):  # NaN -> null, never a fake number
        return None
    return obj


def _carry(previous: dict[str, Any] | None, key: str, error: str) -> dict[str, Any] | None:
    """Reuse the previous snapshot's section, marked stale."""
    if not previous or key not in previous:
        return None
    section = dict(previous[key])
    section["stale"] = True
    section["reason"] = f"Today's update failed, showing the last good data. ({error})"
    section["last_error"] = error
    return section


def _fred_mood(fred: MacroProvider, start: date, end: date) -> tuple[pd.Series, pd.Series]:
    index, _ = validate_series(fred.fetch_series(INDEX_SERIES, start, end))
    vix, _ = validate_series(fred.fetch_series(VIX_SERIES, start, end))
    return index, vix


def _yahoo_mood(prices: PriceProvider, start: date, end: date) -> tuple[pd.Series, pd.Series]:
    out = []
    for sym in (YAHOO_INDEX, YAHOO_VIX):
        bars, _ = validate_bars(prices.fetch_daily_bars(sym, start, end))
        out.append(bars["close"].astype(float))
    return out[0], out[1]


def mood_section(
    now: datetime, fred: MacroProvider, cfg: AppConfig, cal: MarketCalendar,
    previous: dict[str, Any] | None, prices: PriceProvider | None = None,
) -> dict[str, Any]:  # fmt: skip
    """FRED first; Yahoo (^GSPC, ^VIX) only if FRED fails. Both are real fetched closes."""
    start = now.date() - timedelta(days=HISTORY_DAYS)
    sources: list[tuple[str, int, Any]] = [
        (f"FRED ({INDEX_SERIES}, {VIX_SERIES})", FRED_LAG_SESSIONS,
         lambda: _fred_mood(fred, start, now.date())),
    ]  # fmt: skip
    if prices is not None:
        sources.append((f"Yahoo Finance ({YAHOO_INDEX}, {YAHOO_VIX})", 0,
                        lambda: _yahoo_mood(prices, start, now.date())))  # fmt: skip
    errors: list[str] = []
    for source, lag, fetch in sources:
        try:
            index, vix = fetch()
            if index.empty or vix.empty:
                raise ProviderError(f"{source}: empty series")
        except (ProviderError, ValueError) as exc:
            errors.append(str(exc))
            continue
        result = market_mood(index.sort_index(), float(vix.sort_index().iloc[-1]), cfg.mood)
        expected = cal.last_completed_session(now)
        threshold = expected
        for _ in range(lag):
            threshold = cal.previous_session(threshold)
        index_day: date = max(index.index)
        vix_day: date = max(vix.index)
        behind = [n for n, d in (("S&P 500", index_day), ("VIX", vix_day)) if d < threshold]
        return {
            "result": _jsonable(result),
            "source": source,
            "index_day": index_day.isoformat(),
            "vix_day": vix_day.isoformat(),
            "expected_day": expected.isoformat(),
            "fetched_at": now.isoformat(),
            "stale": bool(behind),
            "reason": f"{' and '.join(behind)} data is older than expected" if behind else "",
            "last_error": "; ".join(errors),  # a failed first source is worth knowing about
        }
    error = "; ".join(errors)
    carried = _carry(previous, "mood", error)
    if carried:
        return carried
    mood = market_mood(pd.Series(dtype=float), None, cfg.mood)
    return {"result": _jsonable(mood), "source": "none", "index_day": None, "vix_day": None,
            "fetched_at": now.isoformat(), "stale": True,
            "reason": f"no market data yet ({error})", "last_error": error}  # fmt: skip


def _history_start(now: datetime) -> date:
    """Enough for the phone's 1Y and YTD charts."""
    return min(date(now.year, 1, 1), now.date() - timedelta(days=HISTORY_CHART_DAYS))


def prices_section(
    now: datetime, prices: PriceProvider | None, symbols: list[str], cal: MarketCalendar,
    previous: dict[str, Any] | None, watch: list[str] | None = None,
) -> dict[str, Any]:  # fmt: skip
    """Last close, day change and about a year of daily closes for each symbol.

    `watch` (the plan's tickers) decides staleness; other symbols (the rest of the public company
    list) are a bonus. A symbol that fails is listed in `missing` and gets no numbers: nothing is
    filled in, and a day a symbol didn't trade is null in its history, never interpolated.
    """
    watch = symbols if watch is None else watch
    expected = cal.last_completed_session(now)
    empty_history: dict[str, Any] = {"days": [], "closes": {}}
    if prices is None:
        return {"quotes": {}, "history": empty_history, "missing": symbols, "source": "none",
                "expected_day": expected.isoformat(), "fetched_at": None, "stale": True,
                "reason": "prices are not set up", "last_error": ""}  # fmt: skip
    quotes: dict[str, dict[str, Any]] = {}
    series: dict[str, pd.Series] = {}
    errors: dict[str, str] = {}
    start = _history_start(now)
    for sym in symbols:
        try:
            bars, _ = validate_bars(prices.fetch_daily_bars(sym, start, now.date()))
        except (ProviderError, ValueError) as exc:
            errors[sym] = str(exc)
            continue
        closes = bars["close"].astype(float)
        if closes.empty:
            errors[sym] = "no recent prices"
            continue
        series[sym] = closes
        last = float(closes.iloc[-1])
        prev = float(closes.iloc[-2]) if len(closes) > 1 else None
        quotes[sym] = {
            "close": round(last, 4),
            "prev_close": round(prev, 4) if prev is not None else None,
            "change_pct": round((last / prev - 1) * 100, 4) if prev else None,
            "day": closes.index[-1].isoformat(),
        }
    error = "; ".join(f"{s}: {e}" for s, e in errors.items())
    if not quotes:
        carried = _carry(previous, "prices", error or "no symbols")
        if carried:
            return carried
    days = sorted(set().union(*(set(c.index) for c in series.values()))) if series else []
    history = {
        "days": [d.isoformat() for d in days],
        "closes": {
            sym: [None if pd.isna(v) else round(float(v), 4) for v in c.reindex(days)]
            for sym, c in series.items()
        },
    }
    behind = sorted(s for s in watch if s in quotes and quotes[s]["day"] < expected.isoformat())
    missing = [s for s in symbols if s not in quotes]
    watch_missing = [s for s in watch if s not in quotes]
    reason = ""
    if not quotes:
        reason = "prices could not be fetched"
    elif watch_missing or behind:
        parts = [f"no price for {', '.join(watch_missing)}"] if watch_missing else []
        parts += [f"{', '.join(behind)} price is older than expected"] if behind else []
        reason = "; ".join(parts)
    return {
        "quotes": quotes,
        "history": history,
        "missing": missing,
        "source": prices.name,
        "expected_day": expected.isoformat(),
        "fetched_at": now.isoformat() if quotes else None,
        "stale": bool(watch_missing or behind),
        "reason": reason,
        "last_error": error,
    }


def plan_section(
    now: datetime, sec: FundamentalsProvider, cfg: AppConfig, clock: Clock,
    previous: dict[str, Any] | None,
) -> dict[str, Any]:  # fmt: skip
    engine = make_engine(None)
    init_schema(engine)
    svc = FundamentalsService(make_session_factory(engine), sec, timedelta(days=1), clock)
    svc.refresh(list(cfg.plan.candidates), force=True)
    status = svc.status()
    if status.fetched_at is None:
        carried = _carry(previous, "plan", status.last_error or "SEC refresh failed")
        if carried:
            return carried
    results = run_screen(cfg, svc)
    names = {f.symbol: f.name or f.symbol for f in cfg.plan.core_funds}
    names |= {r.symbol: r.company for r in results}
    targets = build_targets(cfg.plan, [(r.symbol, r.why) for r in results if r.picked])
    return {
        "targets": [
            {
                "symbol": t.symbol,
                "name": names.get(t.symbol, t.symbol),
                "kind": t.kind,
                "target_pct": round(t.target_pct, 4),
                "why": t.why,
            }
            for t in targets
        ],
        "screen": _jsonable(results),
        "source": status.source or sec.name,
        "fetched_at": status.fetched_at.isoformat() if status.fetched_at else None,
        "stale": status.fetched_at is None,
        "reason": "company reports could not be read" if status.fetched_at is None else "",
        "last_error": status.last_error,
    }


def learn_section(verify: bool, client: httpx.Client | None = None) -> dict[str, Any]:
    content = load_learn()
    if verify:
        from keystone_ledger.tools.verify_links import check

        client = client or httpx.Client(
            timeout=20.0,
            follow_redirects=False,
            headers={"User-Agent": "KeystoneLedger link check"},
        )
        today = utcnow().date()
        links = [
            link.model_copy(update={"verified_on": today}) if check(client, str(link.url))[0]
            else link.model_copy(update={"verified_on": None})
            for link in content.links
        ]  # fmt: skip
        content = content.model_copy(update={"links": links})
    return for_display(content).model_dump(mode="json")


def price_symbols(cfg: AppConfig, plan: dict[str, Any]) -> list[str]:
    """The plan's tickers first, then the rest of the public company list (all from config, so
    nothing personal), so a holding you add from that list gets a price and a chart too."""
    syms = [t["symbol"] for t in plan["targets"]]
    syms += [f.symbol for f in cfg.plan.core_funds] + list(cfg.plan.candidates)
    return list(dict.fromkeys(syms))


def build_snapshot(
    *,
    cfg: AppConfig,
    fred: MacroProvider,
    sec: FundamentalsProvider,
    calendar: MarketCalendar,
    prices: PriceProvider | None = None,
    previous: dict[str, Any] | None = None,
    verify_links: bool = False,
    clock: Clock = utcnow,
) -> dict[str, Any]:
    now = clock()
    plan = plan_section(now, sec, cfg, clock, previous)
    return {
        "schema": SCHEMA,
        "app_version": __version__,
        "generated_at": now.isoformat(),
        "mood": mood_section(now, fred, cfg, calendar, previous, prices),
        "plan": plan,
        "prices": prices_section(
            now,
            prices,
            price_symbols(cfg, plan),
            calendar,
            previous,
            watch=[t["symbol"] for t in plan["targets"]],
        ),
        "rules": {
            "drift": cfg.drift.model_dump(),
            "core_pct": cfg.plan.core_pct,
            "stocks_pct": cfg.plan.stocks_pct,
            "max_single_stock_pct": cfg.plan.max_single_stock_pct,
        },
        "learn": learn_section(verify_links),
    }


def _load_previous(url: str | None) -> dict[str, Any] | None:
    if not url:
        return None
    try:
        r = httpx.get(url, timeout=20.0, follow_redirects=True)
        if r.status_code == 200:
            data = r.json()
            if isinstance(data, dict) and data.get("schema") == SCHEMA:
                return data
    except (httpx.HTTPError, ValueError) as exc:
        log.warning("snapshot: previous snapshot unavailable: %s", type(exc).__name__)
    return None


SECTIONS = (("mood", "Market mood"), ("prices", "Ticker prices"), ("plan", "Company reports"))


def report(snap: dict[str, Any]) -> str:
    """A Markdown status table for the Actions run page. Public data only."""
    lines = [
        "### Today's snapshot",
        "",
        "| Part | Status | Source | Details |",
        "|---|---|---|---|",
    ]
    for key, label in SECTIONS:
        sec = snap[key]
        status = "⚠️ stale" if sec["stale"] else "✅ fresh"
        details = " ".join(x for x in (sec.get("reason", ""), sec.get("last_error", "")) if x)
        lines.append(
            f"| {label} | {status} | {sec.get('source', '')} | {details.replace('|', '/')} |"
        )
    watch = [t["symbol"] for t in snap["plan"]["targets"]]
    quotes = {s: q for s, q in snap["prices"].get("quotes", {}).items() if s in watch}
    if quotes:
        lines += ["", "| Ticker | Last close | Day | Change |", "|---|---|---|---|"]
        for sym, q in quotes.items():
            change = f"{q['change_pct']:+.2f}%" if q["change_pct"] is not None else "—"
            lines.append(f"| {sym} | {q['close']:.2f} | {q['day']} | {change} |")
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    from keystone_ledger.core.logging import configure_logging
    from keystone_ledger.data.fred_provider import FredCsvProvider
    from keystone_ledger.data.sec_provider import SecEdgarProvider
    from keystone_ledger.data.yfinance_provider import YFinanceProvider
    from keystone_ledger.settings import get_settings

    configure_logging()
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--previous", help="URL of the currently published snapshot.json")
    ap.add_argument("--verify-links", action="store_true")
    args = ap.parse_args(argv)
    settings = get_settings()
    cfg = load_config(settings.config_path if settings.config_path.exists()
                      else REPO_ROOT / "config" / "keystone.example.toml")  # fmt: skip
    snap = build_snapshot(
        cfg=cfg,
        fred=FredCsvProvider(MinIntervalLimiter(1.0)),
        sec=SecEdgarProvider(
            settings.sec_user_agent, MinIntervalLimiter(cfg.data.sec_requests_per_second)
        ),
        calendar=MarketCalendar(),
        prices=YFinanceProvider(MinIntervalLimiter(1.0)),
        previous=_load_previous(args.previous),
        verify_links=args.verify_links,
    )
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(snap, indent=1, ensure_ascii=False), encoding="utf-8")
    for key, label in SECTIONS:
        sec = snap[key]
        if sec["stale"] or sec.get("last_error"):
            log.warning("snapshot: %s: stale=%s reason=%r error=%r", label, sec["stale"],
                        sec.get("reason", ""), sec.get("last_error", ""))  # fmt: skip
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as fh:
            fh.write(report(snap))
    log.info("snapshot: wrote %s (%s)", args.out,
             ", ".join(f"{k} stale={snap[k]['stale']}" for k, _ in SECTIONS))  # fmt: skip
    return 0


if __name__ == "__main__":
    sys.exit(main())

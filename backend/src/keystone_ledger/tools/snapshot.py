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
from collections.abc import Collection, Mapping
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
from keystone_ledger.core.screen import EPS_TAGS
from keystone_ledger.core.valuation import valuation
from keystone_ledger.core.watch import (
    affinity,
    keep_list,
    quarter_of,
    record_quarter,
    status_of,
    trend_of,
)
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
from keystone_ledger.tools.validate_snapshot import validate

log = logging.getLogger("keystone_ledger.snapshot")

SCHEMA = 1
INDEX_SERIES = "SP500"  # FRED: S&P 500 daily close (10-year window)
VIX_SERIES = "VIXCLS"
HISTORY_DAYS = 500  # comfortably more than 200 trading days
FRED_LAG_SESSIONS = 1  # FRED posts daily series about one session behind
YAHOO_INDEX = "^GSPC"
YAHOO_VIX = "^VIX"
LONG_HISTORY_YEARS = 6  # year-end closes for the price check's 5-year median
MAX_DAY_MOVE_PCT = 50.0  # a bigger one-day move is treated as a data error, never published
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


def _year_end_closes(closes: pd.Series) -> dict[int, float]:
    """Last close of each complete calendar year (the session on or before Dec 31)."""
    out: dict[int, float] = {}
    for d, v in closes.items():
        if isinstance(d, date) and d.month == 12 and d.day >= 20:
            out[d.year] = float(v)  # ascending, so the last December session wins
    return out


def _history(series: Mapping[str, pd.Series], splits: dict[str, list[list[Any]]]) -> dict[str, Any]:
    """Columnar closes on the union of trading days; a day a ticker didn't trade stays null."""
    days = sorted(set().union(*(set(c.index) for c in series.values()))) if series else []
    return {
        "days": [d.isoformat() for d in days],
        "closes": {
            sym: [None if pd.isna(v) else round(float(v), 4) for v in c.reindex(days)]
            for sym, c in series.items()
        },
        "splits": splits,
    }


def _quote(
    closes: pd.Series, divs: Mapping[date, float], now: datetime, has_divs: bool
) -> dict[str, Any]:
    last = float(closes.iloc[-1])
    prev = float(closes.iloc[-2]) if len(closes) > 1 else None
    change = (last / prev - 1) * 100 if prev else None
    year_ago = now.date() - timedelta(days=365)
    ttm = sum(v for d, v in divs.items() if d > year_ago)
    return {
        "close": round(last, 4),
        "prev_close": round(prev, 4) if prev is not None else None,
        "change_pct": round(change, 4) if change is not None else None,
        "day": closes.index[-1].isoformat(),
        # Dividends paid over the last 12 months / price: what $100 earned in cash, per year.
        "dividend_yield_pct": round(ttm / last * 100, 2) if has_divs and ttm > 0 else None,
    }


def _fetch_closes(
    prices: PriceProvider, fetch_history: Any, sym: str, begin: date, now: datetime
) -> tuple[pd.Series, dict[date, float], dict[date, float]]:
    """Validated closes plus splits and dividends (empty when the provider can't report them)."""
    if fetch_history is not None:
        raw, split_map, divs = fetch_history(sym, begin, now.date())
    else:
        raw, split_map, divs = prices.fetch_daily_bars(sym, begin, now.date()), {}, {}
    bars, _ = validate_bars(raw)
    closes = bars["close"].astype(float)
    if closes.empty:
        raise ProviderError("no recent prices")
    return closes, split_map, divs


def prices_section(
    now: datetime, prices: PriceProvider | None, symbols: list[str], cal: MarketCalendar,
    previous: dict[str, Any] | None, watch: list[str] | None = None,
    long_symbols: Collection[str] = (), extras: dict[str, Any] | None = None,
) -> dict[str, Any]:  # fmt: skip
    """Last close, day change, dividend yield and about a year of daily closes for each symbol.

    `watch` (the plan's tickers) decides staleness; other symbols (the rest of the public company
    list) are a bonus. A symbol that fails is listed in `missing` and gets no numbers: nothing is
    filled in, and a day a symbol didn't trade is null in its history, never interpolated.
    `long_symbols` are fetched about six years back so their year-end closes can be put in
    `extras["year_end"]` (for the price check); only a year is published.
    A non-plan ticker whose last day moved more than MAX_DAY_MOVE_PCT is dropped as suspect.
    """
    watch = symbols if watch is None else watch
    extras = {} if extras is None else extras
    expected = cal.last_completed_session(now)
    empty_history: dict[str, Any] = {"days": [], "closes": {}, "splits": {}}
    if prices is None:
        return {"quotes": {}, "history": empty_history, "missing": symbols, "source": "none",
                "expected_day": expected.isoformat(), "fetched_at": None, "stale": True,
                "reason": "prices are not set up", "last_error": ""}  # fmt: skip
    quotes: dict[str, dict[str, Any]] = {}
    series: dict[str, pd.Series] = {}
    splits: dict[str, list[list[Any]]] = {}
    year_end: dict[str, dict[int, float]] = {}
    errors: dict[str, str] = {}
    start = _history_start(now)
    long_start = date(now.year - LONG_HISTORY_YEARS, 1, 1)
    # Providers that can report splits and dividends do it in the same request (the phone needs
    # splits to value shares bought before one); others just give bars.
    fetch_history = getattr(prices, "fetch_history", None)
    for sym in symbols:
        begin = long_start if sym in long_symbols else start
        try:
            all_closes, split_map, divs = _fetch_closes(prices, fetch_history, sym, begin, now)
        except (ProviderError, ValueError) as exc:
            errors[sym] = str(exc)
            continue
        if sym in long_symbols:
            year_end[sym] = _year_end_closes(all_closes)
        closes = all_closes[[d >= start for d in all_closes.index]]
        if closes.empty:
            errors[sym] = "no recent prices"
            continue
        q = _quote(closes, divs, now, fetch_history is not None)
        if q["change_pct"] is not None and abs(q["change_pct"]) > MAX_DAY_MOVE_PCT \
                and sym not in watch:  # fmt: skip
            errors[sym] = f"suspect {q['change_pct']:+.0f}% one-day move, left out"
            continue
        series[sym] = closes
        if split_map:
            splits[sym] = [[d.isoformat(), r] for d, r in sorted(split_map.items())]
        quotes[sym] = q
    extras["year_end"] = year_end
    error = "; ".join(f"{s}: {e}" for s, e in errors.items())
    if not quotes:
        carried = _carry(previous, "prices", error or "no symbols")
        if carried:
            return carried
    history = _history(series, splits)
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


def _eps_by_year(facts: Mapping[tuple[str, str], float], years: list[int]) -> dict[int, float]:
    out: dict[int, float] = {}
    for y in years:
        for tag in EPS_TAGS:
            v = facts.get((tag, f"CY{y}"))
            if v is not None:
                out[y] = v
                break
    return out


def plan_section(
    now: datetime, sec: FundamentalsProvider, cfg: AppConfig, clock: Clock,
    previous: dict[str, Any] | None, extras: dict[str, Any] | None = None,
) -> dict[str, Any]:  # fmt: skip
    """Screen, quarterly check-in, anti-churn picks and affinity-weighted targets.

    `extras` receives `screen_history` (to publish) and `eps` (for the price check)."""
    extras = {} if extras is None else extras
    prev_history = list((previous or {}).get("screen_history") or [])
    extras["screen_history"] = prev_history
    extras["eps"] = {}
    engine = make_engine(None)
    init_schema(engine)
    svc = FundamentalsService(make_session_factory(engine), sec, timedelta(days=1), clock)
    svc.refresh(list(cfg.plan.candidates), force=True, all_companies=cfg.data.research_enabled)
    status = svc.status()
    if status.fetched_at is not None:
        extras["svc"] = svc  # for the Search tab's research.json
    if status.fetched_at is None:
        carried = _carry(previous, "plan", status.last_error or "SEC refresh failed")
        if carried:
            return carried
    # 1) Who passes today -> this quarter's check-in -> on watch / replace.
    first = run_screen(cfg, svc)
    history = record_quarter(prev_history, quarter_of(now.date()), first) if status.fetched_at \
        else prev_history  # fmt: skip
    extras["screen_history"] = history
    statuses = {r.symbol: status_of(r.symbol, history, cfg.screen.replace_after_failed_quarters)
                for r in first}  # fmt: skip
    # 2) Last time's picks stay unless replaced; open slots go to the best qualifiers.
    prev_picks = [t["symbol"] for t in ((previous or {}).get("plan") or {}).get("targets", [])
                  if t.get("kind") == "stock"]  # fmt: skip
    results = run_screen(cfg, svc, keep=keep_list(prev_picks, statuses))
    picks = [r for r in results if r.picked]
    trends = {r.symbol: trend_of(r.symbol, history) for r in picks}
    aff = affinity(picks, statuses, trends)
    facts = svc.facts([r.symbol for r in picks])
    extras["eps"] = {r.symbol: _eps_by_year(facts.get(r.symbol, {}), svc.years()) for r in picks}
    names = {f.symbol: f.name or f.symbol for f in cfg.plan.core_funds}
    names |= {r.symbol: r.company for r in results}
    targets = build_targets(
        cfg.plan, [(r.symbol, r.why) for r in picks], [aff[r.symbol].weight for r in picks]
    )
    core_weights = {f.symbol: f.weight_pct for f in cfg.plan.core_funds}
    out_targets = []
    for t in targets:
        row: dict[str, Any] = {
            "symbol": t.symbol,
            "name": names.get(t.symbol, t.symbol),
            "kind": t.kind,
            "target_pct": round(t.target_pct, 4),
            "why": t.why,
        }
        if t.kind == "core":
            row["base_pct"] = core_weights[t.symbol]
        else:
            a = aff[t.symbol]
            row |= {"weight": a.weight, "trend": a.trend, "status": a.status,
                    "affinity_reason": a.reason}  # fmt: skip
        out_targets.append(row)
    return {
        "targets": out_targets,
        "screen": _jsonable(results),
        "watch": {sym: st for sym, st in statuses.items() if st != "ok"},
        "quarter": quarter_of(now.date()),
        "source": status.source or sec.name,
        "fetched_at": status.fetched_at.isoformat() if status.fetched_at else None,
        "stale": status.fetched_at is None,
        "reason": "company reports could not be read" if status.fetched_at is None else "",
        "last_error": status.last_error,
    }


def attach_valuation(plan: dict[str, Any], prices: dict[str, Any], cfg: AppConfig,
                     eps: Mapping[str, Mapping[int, float]],
                     year_end: Mapping[str, Mapping[int, float]]) -> None:  # fmt: skip
    """Add the price check to each picked company (in place)."""
    quotes = prices.get("quotes", {})
    for t in plan.get("targets", []):
        if t.get("kind") != "stock":
            continue
        q = quotes.get(t["symbol"])
        split_rows = ((prices.get("history") or {}).get("splits") or {}).get(t["symbol"], [])
        splits = {date.fromisoformat(d): float(r) for d, r in split_rows}
        v = valuation(
            eps.get(t["symbol"], {}), year_end.get(t["symbol"], {}),
            q["close"] if q else None, cfg.screen.valuation_pe_multiple, splits,
        )  # fmt: skip
        t["valuation"] = _jsonable(v)


def holdings_overlap(prices: PriceProvider | None, fund: str, now: datetime) -> dict[str, Any]:
    """The core US fund's largest holdings, to show how much of the stock picks it already owns."""
    fetch = getattr(prices, "fetch_top_holdings", None)
    if fetch is None:
        return {"fund": fund, "top": [], "source": "none", "fetched_at": None,
                "error": "holdings not available from this price source"}  # fmt: skip
    try:
        top = fetch(fund)
    except (ProviderError, ValueError) as exc:
        return {"fund": fund, "top": [], "source": prices.name if prices else "none",
                "fetched_at": None, "error": str(exc)}  # fmt: skip
    return {"fund": fund, "top": [{"symbol": s, "weight_pct": w} for s, w in top],
            "source": prices.name if prices else "none", "fetched_at": now.isoformat(),
            "error": ""}  # fmt: skip


def sessions_list(cal: MarketCalendar, now: datetime) -> list[dict[str, str]]:
    """Recent and upcoming market days with their closing times (UTC), so the phone can tell how
    many trading days old the prices are without guessing at holidays or early closes."""
    start = now.date() - timedelta(days=21)
    end = now.date() + timedelta(days=70)
    return [{"day": d.isoformat(), "close": c.isoformat()}
            for d, c in cal.sessions_with_close(start, end)]  # fmt: skip


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
    """The plan's tickers, then the company list, then the broad extra list (all from config, so
    nothing personal), so most holdings get a daily price and a chart."""
    syms = [t["symbol"] for t in plan["targets"]]
    syms += [f.symbol for f in cfg.plan.core_funds] + list(cfg.plan.candidates)
    syms += list(cfg.data.extra_tickers)
    return list(dict.fromkeys(syms))


def stock_symbols(plan: dict[str, Any]) -> list[str]:
    return [t["symbol"] for t in plan.get("targets", []) if t.get("kind") == "stock"]


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
    side: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """`side` (if given) receives `svc`, the SEC data, so research.json can reuse it."""
    now = clock()
    extras: dict[str, Any] = {}
    plan = plan_section(now, sec, cfg, clock, previous, extras)
    picks = stock_symbols(plan)
    price_extras: dict[str, Any] = {}
    price_data = prices_section(
        now, prices, price_symbols(cfg, plan), calendar, previous,
        watch=[t["symbol"] for t in plan["targets"]], long_symbols=set(picks),
        extras=price_extras,
    )  # fmt: skip
    attach_valuation(plan, price_data, cfg, extras.get("eps", {}), price_extras.get("year_end", {}))
    if side is not None:
        side["svc"] = extras.get("svc")
    core_us = cfg.plan.core_funds[0].symbol
    return {
        "schema": SCHEMA,
        "app_version": __version__,
        "generated_at": now.isoformat(),
        "mood": mood_section(now, fred, cfg, calendar, previous, prices),
        "plan": plan,
        "prices": price_data,
        "overlap": holdings_overlap(prices, core_us, now)
        if picks
        else {
            "fund": core_us,
            "top": [],
            "source": "none",
            "fetched_at": None,
            "error": "no picks",
        },
        "screen_history": extras.get("screen_history", []),
        "sessions": sessions_list(calendar, now),
        "rules": {
            "drift": cfg.drift.model_dump(),
            "core_pct": cfg.plan.core_pct,
            "stocks_pct": cfg.plan.stocks_pct,
            "max_single_stock_pct": cfg.plan.max_single_stock_pct,
            "core_funds": [
                {"symbol": f.symbol, "weight_pct": f.weight_pct} for f in cfg.plan.core_funds
            ],
            "replace_after_failed_quarters": cfg.screen.replace_after_failed_quarters,
            "valuation_pe_multiple": cfg.screen.valuation_pe_multiple,
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


def publish(snap: dict[str, Any], previous: dict[str, Any] | None, out: Path,
            now: datetime, research: dict[str, Any] | None = None) -> dict[str, Any]:  # fmt: skip
    """Write snapshot.json only if it validates; otherwise keep the last good one. Always write
    status.json next to it, so the phone knows whether today's update worked."""
    errors = validate(snap, previous)
    kept = bool(errors) and previous is not None and not validate(previous)
    published = previous if kept and previous is not None else snap
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(published, indent=1, ensure_ascii=False), encoding="utf-8")
    status = {
        "schema": 1,
        "ok": not errors,
        "checked_at": now.isoformat(),
        "published_generated_at": published.get("generated_at"),
        "kept_previous": kept,
        "errors": errors[:20],
    }
    if research is not None:
        status["research"] = research
    (out.parent / "status.json").write_text(json.dumps(status, indent=1), encoding="utf-8")
    return status


def run_research(snap: dict[str, Any], svc: FundamentalsService | None, cfg: AppConfig,
                 prices: Any, out: Path, previous_url: str | None) -> dict[str, Any]:  # fmt: skip
    """Build and write research.json (next to snapshot.json). It only publishes if it validates;
    otherwise the last good one is kept. It never stops the snapshot from publishing."""
    from keystone_ledger.tools.research import build_research, write_research

    errors: list[str] = []
    research: dict[str, Any] | None = None
    if not cfg.data.research_enabled:
        errors.append("research: turned off in the config")
    elif svc is None:
        errors.append("research: SEC data unavailable today")
    else:
        now = datetime.fromisoformat(snap["generated_at"])
        last = date.fromisoformat(snap["prices"]["expected_day"]) if snap["prices"].get(
            "expected_day") else now.date()  # fmt: skip
        try:
            research = build_research(now, last, svc, cfg, prices,
                                      snap["prices"].get("quotes", {}))  # fmt: skip
        except Exception as exc:  # a bug here must never cost the day's snapshot
            log.exception("research: build failed")
            errors.append(f"research: build failed ({type(exc).__name__})")
    prev_url = previous_url.rsplit("/", 1)[0] + "/research.json" if previous_url else None
    return write_research(research, errors, out.parent / "research.json", prev_url)


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
    previous = _load_previous(args.previous)
    side: dict[str, Any] = {}
    prices = YFinanceProvider(MinIntervalLimiter(1.0))
    snap = build_snapshot(
        cfg=cfg,
        fred=FredCsvProvider(MinIntervalLimiter(1.0)),
        sec=SecEdgarProvider(
            settings.sec_user_agent, MinIntervalLimiter(cfg.data.sec_requests_per_second)
        ),
        calendar=MarketCalendar(),
        prices=prices,
        previous=previous,
        verify_links=args.verify_links,
        side=side,
    )
    research = run_research(snap, side.get("svc"), cfg, prices, args.out, args.previous)
    status = publish(snap, previous, args.out, utcnow(), research)
    if not status["ok"]:
        log.error("snapshot: NOT published, %s: %s",
                  "kept the last good one" if status["kept_previous"] else "no good one to keep",
                  "; ".join(status["errors"]))  # fmt: skip
    for key, label in SECTIONS:
        sec = snap[key]
        if sec["stale"] or sec.get("last_error"):
            log.warning("snapshot: %s: stale=%s reason=%r error=%r", label, sec["stale"],
                        sec.get("reason", ""), sec.get("last_error", ""))  # fmt: skip
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as fh:
            fh.write(report(snap))
            if not status["ok"]:
                fh.write("\n**Not published (kept the last good snapshot):**\n\n")
                fh.write("".join(f"- {e}\n" for e in status["errors"]))
    log.info("snapshot: wrote %s (%s)", args.out,
             ", ".join(f"{k} stale={snap[k]['stale']}" for k, _ in SECTIONS))  # fmt: skip
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""research.json for the phone's Search tab: a verdict for every US company with at least
`research_min_revenue_usd` of yearly sales, plus price-only entries for funds.

All public data: SEC filings (the frames the plan already downloads cover every filer) and
Yahoo closes fetched in batches. Nothing is estimated: a company whose numbers can't be read gets
"not enough data", and a missing price is simply absent.
"""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Mapping
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx

from keystone_ledger.config import AppConfig
from keystone_ledger.core.research import VERDICT_WORDS, judge
from keystone_ledger.core.screen import (
    EPS_TAGS,
    OPERATING_INCOME_TAGS,
    REVENUE_TAGS,
    Candidate,
    screen,
)
from keystone_ledger.core.valuation import valuation
from keystone_ledger.data.base import ProviderError
from keystone_ledger.data.fundamentals import FundamentalsService
from keystone_ledger.data.yfinance_provider import BatchHistory

log = logging.getLogger("keystone_ledger.research")

SCHEMA = 1
CHUNK = 100  # tickers per batch request
SYMBOL = re.compile(r"^[A-Z]{1,5}(\.[A-Z])?$")  # plain US listings (BRK.B yes, warrants no)
LONG_YEARS = 6  # year-end closes for the price check's 5-year median
FUND_NOTE = "A fund (a basket of many companies), so the company checks don't apply. Price only."
PRICE_ONLY_NOTE = (
    "No yearly SEC report we can read for it (companies based outside the US report "
    "differently), so there's nothing fair to judge it on. Price only."
)
# Well-known index funds/ETFs. Anything else without SEC numbers is "price only", never "fund".
KNOWN_FUNDS = frozenset(
    {
        "SPY",
        "VOO",
        "IVV",
        "QQQ",
        "QQQM",
        "VT",
        "VTI",
        "VXUS",
        "ITOT",
        "SCHB",
        "SCHX",
        "SCHG",
        "SCHD",
        "VUG",
        "VTV",
        "VIG",
        "VYM",
        "DGRO",
        "JEPI",
        "IXUS",
        "VEA",
        "VWO",
        "BND",
        "AGG",
        "VNQ",
        "IWM",
        "DIA",
        "VGT",
        "XLK",
        "XLE",
        "XLF",
        "XLV",
        "SMH",
        "SOXX",
        "ARKK",
    }
)


def _batches(provider: Any, symbols: list[str], start: date, end: date,
             errors: list[str]) -> dict[str, BatchHistory]:  # fmt: skip
    fetch = getattr(provider, "fetch_batch", None)
    out: dict[str, BatchHistory] = {}
    if fetch is None:
        errors.append("prices: this source can't fetch in batches")
        return out
    for i in range(0, len(symbols), CHUNK):
        chunk = symbols[i : i + CHUNK]
        try:
            out |= fetch(chunk, start, end, "1d")
        except (ProviderError, ValueError) as exc:
            errors.append(f"prices {chunk[0]}..{chunk[-1]}: {exc}")
    return out


def _eps(facts: Mapping[tuple[str, str], float], years: list[int]) -> dict[int, float]:
    out: dict[int, float] = {}
    for y in years:
        for tag in EPS_TAGS:
            v = facts.get((tag, f"CY{y}"))
            if v is not None:
                out[y] = v
                break
    return out


def _year_end(closes: Any, before_year: int) -> dict[int, float]:
    """Last December close of each complete year (closes are ascending by day)."""
    out: dict[int, float] = {}
    for d, v in closes.items():
        if d.month == 12 and d.day >= 20 and d.year < before_year:
            out[d.year] = float(v)
    return out


QUARTERS = 6  # calendar quarters of sales and profit, for the quarterly trend
SHARES_TAG = "WeightedAverageNumberOfDilutedSharesOutstanding"


def _recent_quarters(now: datetime) -> list[tuple[int, int]]:
    """The last QUARTERS complete calendar quarters, newest first."""
    y, q = now.year, (now.month - 1) // 3  # the quarter before the current one
    out = []
    for _ in range(QUARTERS):
        if q == 0:
            y, q = y - 1, 4
        out.append((y, q))
        q -= 1
    return out


def _quarterly(
    provider: Any, now: datetime, errors: list[str]
) -> dict[int, dict[tuple[int, int], tuple[float | None, float | None]]]:
    """CIK -> {(year, quarter): (sales, operating income)} from the SEC's quarterly frames."""
    out: dict[int, dict[tuple[int, int], tuple[float | None, float | None]]] = {}
    for y, q in _recent_quarters(now):
        period = f"CY{y}Q{q}"
        try:
            rev: dict[int, float] = {}
            for tag in REVENUE_TAGS:  # first tag a company reports wins, like the yearly screen
                for cik, fv in provider.fetch_frame(tag, period).items():
                    rev.setdefault(cik, fv.value)
            oi = {
                cik: fv.value
                for tag in OPERATING_INCOME_TAGS
                for cik, fv in provider.fetch_frame(tag, period).items()
            }
        except (ProviderError, ValueError) as exc:
            errors.append(f"quarters {period}: {exc}")
            continue
        for cik in set(rev) | set(oi):
            out.setdefault(cik, {})[(y, q)] = (rev.get(cik), oi.get(cik))
    return out


def _shares(provider: Any, years: list[int], errors: list[str]) -> dict[int, tuple[float, date]]:
    """CIK -> (diluted share count, period end) from the latest yearly report that has it."""
    out: dict[int, tuple[float, date]] = {}
    for y in years[:2]:
        try:
            frame = provider.fetch_frame(SHARES_TAG, f"CY{y}", "shares")
        except (ProviderError, ValueError) as exc:
            errors.append(f"shares CY{y}: {exc}")
            continue
        for cik, fv in frame.items():
            if fv.value > 0:
                out.setdefault(cik, (fv.value, fv.end))
    return out


def _quarter_trend(
    qs: Mapping[tuple[int, int], tuple[float | None, float | None]] | None,
) -> dict[str, Any]:
    """Latest quarter's sales vs the same quarter a year earlier, and its profit per $1."""
    none = {"qp": None, "qg": None, "qom": None, "qom0": None}
    if not qs:
        return none
    for y, q in sorted(qs, reverse=True):
        rev, oi = qs[(y, q)]
        then_rev, then_oi = qs.get((y - 1, q), (None, None))
        if not rev or rev <= 0 or not then_rev or then_rev <= 0:
            continue
        return {
            "qp": f"{y}Q{q}",
            "qg": round((rev / then_rev - 1) * 100, 1),
            "qom": round(oi / rev * 100, 1) if oi is not None else None,
            "qom0": round(then_oi / then_rev * 100, 1) if then_oi is not None else None,
        }
    return none


def _size(close: float | None, shares: tuple[float, date] | None, splits: Mapping[date, float],
          revenue: float | None) -> dict[str, Any]:  # fmt: skip
    """Market value (price x shares) and price per $1 of yearly sales. Skipped when a stock split
    came after the share count's report, since the count would be in old (pre-split) shares."""
    if close is None or shares is None or any(d > shares[1] for d in splits):
        return {"mcap": None, "ps": None}
    mcap = close * shares[0]
    return {
        "mcap": round(mcap),
        "ps": round(mcap / revenue, 2) if revenue and revenue > 0 else None,
    }


def _pct(x: float | None) -> float | None:
    return None if x is None else round(x * 100, 1)


def _trend(m: Any) -> dict[str, Any]:
    """Growth and profit trend for the Moonshot radar: numbers from the SEC reports only."""
    y = m.latest_year
    prev = m.revenue.get(y - 1) if y is not None else None
    last = m.revenue.get(y) if y is not None else None
    g1 = (last / prev - 1) if last and prev and prev > 0 else None
    return {
        "g3": _pct(m.revenue_cagr),  # sales growth, % a year (over the plan's growth window)
        "g1": _pct(g1),  # sales growth in the latest year, %
        "om": _pct(m.operating_margin),  # cents of profit per $1 of sales, latest year
        "om0": _pct(m.operating_margin_prior),  # the same, two years earlier
        "fcfm": _pct(m.fcf_margin),  # cash kept per $1 of sales
    }


def _company(r: Any, j: Any, v: Any, h: Any, now: datetime) -> dict[str, Any]:
    close = prev = day = None
    if h is not None and len(h.closes):
        close = float(h.closes.iloc[-1])
        prev = float(h.closes.iloc[-2]) if len(h.closes) > 1 else None
        day = h.closes.index[-1].isoformat()
    year_ago = now.date() - timedelta(days=365)
    ttm = sum(x for k, x in (h.dividends if h else {}).items() if k > year_ago)
    rev = r.metrics.revenue.get(r.metrics.latest_year or 0)
    return {
        "s": r.symbol,
        "n": r.company,
        "v": j.verdict,
        "h": j.headline,
        "y": r.metrics.latest_year,
        "rev": round(rev) if rev else None,
        "close": round(close, 4) if close else None,
        "chg": round((close / prev - 1) * 100, 3) if close and prev else None,
        "day": day,
        "dy": round(ttm / close * 100, 2) if close and ttm > 0 else None,
        "pe": v.pe,
        "pe_med": v.median_pe,
        "pe_flag": v.flagged,
        "pe_note": v.detail,
        "checks": [[c.label, c.status, c.detail] for c in r.checks],
        **_trend(r.metrics),
    }


def build_research(
    now: datetime,
    last_session: date,
    svc: FundamentalsService,
    cfg: AppConfig,
    prices: Any,
    funds: Mapping[str, Mapping[str, Any]],
) -> dict[str, Any]:
    """`funds`: today's quotes; those that aren't companies with SEC sales (ETFs) are shown
    price-only. Closes after `last_session` (a session still trading) are never used."""
    errors: list[str] = []
    tickers = {t: v for t, v in svc.all_tickers().items() if SYMBOL.fullmatch(t)}
    facts = svc.facts(list(tickers))
    years = svc.years()
    cands = [Candidate(t, "", tickers[t][1], f) for t, f in facts.items()]
    results = screen(cands, years, cfg.screen, max_stocks=0, max_per_sector=1)
    floor = cfg.data.research_min_revenue_usd
    big = [r for r in results if r.metrics.latest_year is not None
           and r.metrics.revenue.get(r.metrics.latest_year, 0) >= floor]  # fmt: skip
    big.sort(key=lambda x: x.symbol)
    # One daily request per ticker covers the quote, dividends, splits and year-end prices.
    start = date(now.year - LONG_YEARS, 1, 1)
    hist = _batches(prices, [r.symbol for r in big], start, last_session, errors)
    quarters = _quarterly(svc.provider, now, errors)
    shares = _shares(svc.provider, years, errors)
    companies: list[dict[str, Any]] = []
    for r in big:
        h = hist.get(r.symbol)
        if h is not None:
            h = h.upto(last_session)
        close = float(h.closes.iloc[-1]) if h is not None and len(h.closes) else None
        year_end = _year_end(h.closes, now.year) if h is not None else {}
        v = valuation(_eps(facts[r.symbol], years), year_end, close,
                      cfg.screen.valuation_pe_multiple, h.splits if h else None)  # fmt: skip
        row = _company(r, judge(r, v, cfg.screen), v, h, now)
        cik = tickers[r.symbol][0]
        row |= _quarter_trend(quarters.get(cik))
        rev = r.metrics.revenue.get(r.metrics.latest_year or 0)
        row |= _size(close, shares.get(cik), h.splits if h else {}, rev)
        companies.append(row)
    with_sales = {r.symbol for r in results if r.metrics.latest_year is not None}
    core = {f.symbol for f in cfg.plan.core_funds}
    names = {f.symbol: f.name or f.symbol for f in cfg.plan.core_funds}
    names |= {t: v[1] for t, v in tickers.items()}
    known = {c["s"] for c in companies}
    for sym, q in sorted(funds.items()):
        if sym in known or sym in with_sales or not SYMBOL.fullmatch(sym) or not q.get("close"):
            continue
        fund = sym in KNOWN_FUNDS or sym in core
        companies.append({"s": sym, "n": names.get(sym, sym), "v": "fund" if fund else "unknown",
                          "h": FUND_NOTE if fund else PRICE_ONLY_NOTE, "close": q["close"],
                          "chg": q.get("change_pct"), "day": q.get("day"),
                          "dy": q.get("dividend_yield_pct")})  # fmt: skip
    priced = sum(1 for c in companies if c.get("close"))
    log.info("research: %d companies (%d priced), %d errors", len(companies), priced, len(errors))
    return {
        "schema": SCHEMA,
        "generated_at": now.isoformat(),
        "source": f"SEC EDGAR frames + {getattr(prices, 'name', 'none')}",
        "min_revenue_usd": floor,
        "verdicts": dict(VERDICT_WORDS),
        "companies": companies,
        "errors": errors[:20],
    }


def validate_research(r: Any) -> list[str]:
    if not isinstance(r, dict) or r.get("schema") != SCHEMA:
        return ["research: unknown format"]
    cos = r.get("companies")
    if not isinstance(cos, list) or not cos:
        return ["research: no companies"]
    errors: list[str] = []
    ok = {"fit", "pricey", "no", "unknown", "fund"}
    for c in cos:
        if not isinstance(c, dict) or not re.fullmatch(r"\^?[A-Z0-9]{1,10}([.\-][A-Z0-9]{1,4})?",
                                                       str(c.get("s", ""))):  # fmt: skip
            errors.append("research: a bad ticker")
            continue
        if c.get("v") not in ok:
            errors.append(f"research: {c['s']} has an unknown verdict")
        close = c.get("close")
        if close is not None and not (isinstance(close, (int, float)) and close > 0):
            errors.append(f"research: {c['s']} has a zero or broken price")
    return errors[:20]


def _load_previous(url: str | None) -> dict[str, Any] | None:
    if not url:
        return None
    try:
        r = httpx.get(url, timeout=30.0, follow_redirects=True)
        data = r.json() if r.status_code == 200 else None
    except (httpx.HTTPError, ValueError) as exc:
        log.warning("research: previous file unavailable: %s", type(exc).__name__)
        return None
    return data if isinstance(data, dict) and not validate_research(data) else None


def write_research(research: dict[str, Any] | None, errors: list[str], out: Path,
                   previous_url: str | None) -> dict[str, Any]:  # fmt: skip
    """Write `research` if it validates, else the last good published one (if any). Returns the
    status that goes into status.json."""
    errors = errors + (validate_research(research) if research is not None else [])
    good = research if research is not None and not errors else None
    kept = False
    if good is None:
        good = _load_previous(previous_url)
        kept = good is not None
    if good is not None:
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(good, separators=(",", ":"), ensure_ascii=False), "utf-8")
    if errors:
        what = "kept the last good one" if kept else "none to keep"
        log.error("research: NOT published (%s): %s", what, "; ".join(errors))
    return {
        "ok": not errors,
        "published_generated_at": good.get("generated_at") if good else None,
        "kept_previous": kept,
        "companies": len(good["companies"]) if good else 0,
        "errors": errors[:20],
    }

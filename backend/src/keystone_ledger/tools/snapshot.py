"""Build the daily snapshot for the iPhone app: `python -m keystone_ledger.tools.snapshot`.

Runs on a schedule in GitHub Actions. The snapshot holds ONLY public data: market mood (FRED's
S&P 500 and VIX series), the plan picks (SEC filings), and the Learn page (links that open).
Nothing personal ever goes in it; holdings and the wall stay on the phone.

Never fabricate: if a source fails, the previous snapshot's section is carried over, marked
stale with the error, so the phone shows old numbers loudly instead of invented ones.
"""

from __future__ import annotations

import argparse
import json
import logging
import math
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
from keystone_ledger.data.base import MacroProvider, ProviderError, validate_series
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


def mood_section(
    now: datetime, fred: MacroProvider, cfg: AppConfig, cal: MarketCalendar,
    previous: dict[str, Any] | None,
) -> dict[str, Any]:  # fmt: skip
    start = now.date() - timedelta(days=HISTORY_DAYS)
    try:
        index, _ = validate_series(fred.fetch_series(INDEX_SERIES, start, now.date()))
        vix, _ = validate_series(fred.fetch_series(VIX_SERIES, start, now.date()))
        if index.empty or vix.empty:
            raise ProviderError("fred: empty series")
    except (ProviderError, ValueError) as exc:
        carried = _carry(previous, "mood", str(exc))
        if carried:
            return carried
        mood = market_mood(pd.Series(dtype=float), None, cfg.mood)
        return {"result": _jsonable(mood), "source": fred.name, "index_day": None, "vix_day": None,
                "fetched_at": now.isoformat(), "stale": True, "reason": "no market data yet",
                "last_error": str(exc)}  # fmt: skip
    result = market_mood(index.sort_index(), float(vix.sort_index().iloc[-1]), cfg.mood)
    expected = cal.last_completed_session(now)
    threshold = expected
    for _ in range(FRED_LAG_SESSIONS):
        threshold = cal.previous_session(threshold)
    index_day: date = max(index.index)
    vix_day: date = max(vix.index)
    behind = [n for n, d in (("S&P 500", index_day), ("VIX", vix_day)) if d < threshold]
    return {
        "result": _jsonable(result),
        "source": f"FRED ({INDEX_SERIES}, {VIX_SERIES})",
        "index_day": index_day.isoformat(),
        "vix_day": vix_day.isoformat(),
        "expected_day": expected.isoformat(),
        "fetched_at": now.isoformat(),
        "stale": bool(behind),
        "reason": f"{' and '.join(behind)} data is older than expected" if behind else "",
        "last_error": "",
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


def build_snapshot(
    *,
    cfg: AppConfig,
    fred: MacroProvider,
    sec: FundamentalsProvider,
    calendar: MarketCalendar,
    previous: dict[str, Any] | None = None,
    verify_links: bool = False,
    clock: Clock = utcnow,
) -> dict[str, Any]:
    now = clock()
    return {
        "schema": SCHEMA,
        "app_version": __version__,
        "generated_at": now.isoformat(),
        "mood": mood_section(now, fred, cfg, calendar, previous),
        "plan": plan_section(now, sec, cfg, clock, previous),
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


def main(argv: list[str] | None = None) -> int:
    from keystone_ledger.core.logging import configure_logging
    from keystone_ledger.data.fred_provider import FredCsvProvider
    from keystone_ledger.data.sec_provider import SecEdgarProvider
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
        previous=_load_previous(args.previous),
        verify_links=args.verify_links,
    )
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(snap, indent=1, ensure_ascii=False), encoding="utf-8")
    log.info("snapshot: wrote %s (mood stale=%s, plan stale=%s)", args.out,
             snap["mood"]["stale"], snap["plan"]["stale"])  # fmt: skip
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""dossier.json: insider trades (Form 4) and big-event filings (8-K) for every Search company.

Public SEC data only. Each run reads EDGAR's daily index for filing days it hasn't read yet,
newest first, within a time budget, and merges them into the previous file's history. So the
first runs fill in the last 90 days gradually, and after that each run only adds the new days.
A day is marked done only once every one of its filings was read, so nothing is half-counted.
"""

from __future__ import annotations

import logging
import re
import time
from collections.abc import Mapping
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

from keystone_ledger.data.base import ProviderError, RateLimitedError
from keystone_ledger.data.edgar_filings import (
    filing_url,
    index_url,
    parse_8k_items,
    parse_form4,
    parse_master_index,
)
from keystone_ledger.data.sec_provider import SecEdgarProvider

log = logging.getLogger("keystone_ledger.dossier")

SCHEMA = 1
WINDOW_DAYS = 90
MAX_TRADES = 30  # per company, newest first
MAX_EVENTS = 15
FORMS = frozenset({"4", "8-K"})
TICKER = re.compile(r"^[A-Z]{1,5}(\.[A-Z])?$")


def _filing_days(today: date, done: set[str]) -> list[date]:
    """EDGAR filing days (weekdays) in the window not read yet, newest first. Today is skipped:
    its index isn't complete until the evening."""
    out = []
    for i in range(1, WINDOW_DAYS + 1):
        d = today - timedelta(days=i)
        if d.weekday() < 5 and d.isoformat() not in done:
            out.append(d)
    return out


def _read_day(sec: SecEdgarProvider, day: date, ciks: Mapping[int, list[str]],
              deadline: float) -> tuple[dict[int, dict[str, list[Any]]], bool]:  # fmt: skip
    """All Form 4 and 8-K filings for our companies on one day. False if time ran out."""
    text = sec.fetch_text(index_url(day), max_bytes=20_000_000)
    found: dict[int, dict[str, list[Any]]] = {}
    if text is None:
        return found, True  # no index: a holiday, nothing filed
    seen: set[str] = set()
    for row in parse_master_index(text, FORMS):
        if row.cik not in ciks or row.path in seen:
            continue
        seen.add(row.path)
        if time.monotonic() > deadline:
            return found, False
        slot = found.setdefault(row.cik, {"t": [], "e": []})
        if row.form == "4":
            body = sec.fetch_text(filing_url(row.path), max_bytes=1_500_000)
            for t in parse_form4(body or "", row.cik):
                slot["t"].append([t.day.isoformat(), t.owner, t.role, t.code, t.shares, t.value,
                                  1 if t.planned else 0])  # fmt: skip
        else:
            head = sec.fetch_text(filing_url(row.path), max_bytes=80_000, stop_at="</SEC-HEADER>")
            items = parse_8k_items(head or "")
            if items:
                slot["e"].append([row.filed.isoformat(), ",".join(items), row.path])
    return found, True


def build_dossier(
    now: datetime,
    sec: SecEdgarProvider,
    ciks: Mapping[int, list[str]],
    previous: Mapping[str, Any] | None,
    budget_s: float,
) -> dict[str, Any]:
    """`ciks`: each Search company's SEC number -> its tickers."""
    oldest = (now.date() - timedelta(days=WINDOW_DAYS)).isoformat()
    prev = previous if previous and not validate_dossier(previous) else None
    done = {d for d in (prev or {}).get("days", []) if d >= oldest}
    companies: dict[str, dict[str, list[Any]]] = {
        s: {"t": [r for r in c["t"] if r[0] >= oldest], "e": [r for r in c["e"] if r[0] >= oldest]}
        for s, c in ((prev or {}).get("companies") or {}).items()
    }
    errors: list[str] = []
    deadline = time.monotonic() + budget_s
    read = 0
    for day in _filing_days(now.date(), done):
        if time.monotonic() > deadline:
            break
        try:
            found, complete = _read_day(sec, day, ciks, deadline)
        except RateLimitedError as exc:
            errors.append(f"{day.isoformat()}: {exc}")
            break  # the SEC asked us to slow down: stop for today
        except (ProviderError, ValueError) as exc:
            errors.append(f"{day.isoformat()}: {exc}")
            continue
        if not complete:
            break  # out of time mid-day: that day is read again from the start next run
        for cik, rows in found.items():
            for sym in ciks[cik]:
                slot = companies.setdefault(sym, {"t": [], "e": []})
                slot["t"] += rows["t"]
                slot["e"] += rows["e"]
        done.add(day.isoformat())
        read += 1
    for slot in companies.values():
        slot["t"] = sorted(
            {tuple(r): r for r in slot["t"]}.values(), key=lambda r: r[0], reverse=True
        )[:MAX_TRADES]
        slot["e"] = sorted({r[2]: r for r in slot["e"]}.values(), key=lambda r: r[0], reverse=True)[
            :MAX_EVENTS
        ]
    companies = {s: c for s, c in sorted(companies.items()) if c["t"] or c["e"]}
    days = sorted(done, reverse=True)
    log.info(
        "dossier: read %d new filing days, %d days covered, %d companies",
        read,
        len(days),
        len(companies),
    )
    return {
        "schema": SCHEMA,
        "generated_at": now.isoformat(),
        "source": "SEC EDGAR (Form 4 insider trades, Form 8-K events)",
        "window_days": WINDOW_DAYS,
        "days": days,
        "companies": companies,
        "errors": errors[:20],
    }


def validate_dossier(d: Any) -> list[str]:
    if not isinstance(d, Mapping) or d.get("schema") != SCHEMA:
        return ["dossier: unknown format"]
    days, cos = d.get("days"), d.get("companies")
    if not isinstance(days, list) or not all(isinstance(x, str) and len(x) == 10 for x in days):
        return ["dossier: bad day list"]
    if not isinstance(cos, Mapping):
        return ["dossier: no companies"]
    errors: list[str] = []
    for sym, c in cos.items():
        if not TICKER.fullmatch(str(sym)) or not isinstance(c, Mapping):
            errors.append("dossier: a bad ticker")
            continue
        t, e = c.get("t"), c.get("e")
        if not isinstance(t, list) or not isinstance(e, list):
            errors.append(f"dossier: {sym} is damaged")
            continue
        for r in t:
            if not (isinstance(r, list) and len(r) == 7 and r[3] in ("P", "S")
                    and all(isinstance(x, (int, float)) and x >= 0 for x in r[4:6])):  # fmt: skip
                errors.append(f"dossier: {sym} has a bad insider trade")
                break
        for r in e:
            if not (isinstance(r, list) and len(r) == 3 and isinstance(r[1], str)):
                errors.append(f"dossier: {sym} has a bad event")
                break
    return errors[:20]


BUDGET_S = 12 * 60  # of EDGAR reading per daily run; the rest catches up on the next runs


def _load(url: str | None) -> dict[str, Any] | None:
    import httpx

    if not url:
        return None
    try:
        r = httpx.get(url, timeout=30.0, follow_redirects=True)
        data = r.json() if r.status_code == 200 else None
    except (httpx.HTTPError, ValueError) as exc:
        log.warning("dossier: previous file unavailable: %s", type(exc).__name__)
        return None
    return data if isinstance(data, dict) and not validate_dossier(data) else None


def run_dossier(now: datetime, sec: SecEdgarProvider, tickers: Mapping[str, tuple[int, str]],
                research_path: Path, out: Path, previous_url: str | None,
                budget_s: float = BUDGET_S) -> dict[str, Any]:  # fmt: skip
    """Build and write dossier.json for the companies in research.json. Publishes only if it
    validates; otherwise the last good one stays. Returns its status for status.json."""
    import json

    previous = _load(previous_url)
    errors: list[str] = []
    dossier: dict[str, Any] | None = None
    try:
        research = json.loads(research_path.read_text(encoding="utf-8"))
        ciks: dict[int, list[str]] = {}
        for c in research.get("companies", []):
            sym = c.get("s")
            if c.get("v") != "fund" and sym in tickers:
                ciks.setdefault(tickers[sym][0], []).append(sym)
        dossier = build_dossier(now, sec, ciks, previous, budget_s)
        errors += validate_dossier(dossier)
    except (OSError, ValueError) as exc:
        errors.append(f"dossier: research.json unreadable ({type(exc).__name__})")
    except Exception as exc:  # a bug here must never cost the day's snapshot
        log.exception("dossier: build failed")
        errors.append(f"dossier: build failed ({type(exc).__name__})")
    good = dossier if dossier is not None and not errors else previous
    kept = good is previous and previous is not None
    if good is not None:
        out.write_text(json.dumps(good, separators=(",", ":"), ensure_ascii=False), "utf-8")
    return {
        "ok": not errors,
        "kept_previous": kept,
        "days_covered": len(good["days"]) if good else 0,
        "companies": len(good["companies"]) if good else 0,
        "errors": (errors + ((dossier or {}).get("errors") or []))[:20],
    }

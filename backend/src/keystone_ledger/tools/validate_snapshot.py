"""Checks a freshly built snapshot before it's published. Pure: returns a list of problems.

If anything is wrong, the daily job keeps the last good snapshot online and publishes a status
file saying what failed, so the phone never shows bad numbers as if they were today's.
"""

from __future__ import annotations

import math
import re
from datetime import date, datetime
from typing import Any

SYMBOL = re.compile(r"^\^?[A-Z0-9]{1,10}([.\-][A-Z0-9]{1,4})?$")
MOODS = {"green", "yellow", "red", "unknown"}
MAX_PLAN_DAY_MOVE_PCT = 50.0  # one-day move of a plan ticker beyond this is treated as bad data
MAX_RUN_TO_RUN_RATIO = 2.5  # vs the last published close, unless a split explains it
REQUIRED = ("schema", "generated_at", "mood", "plan", "prices", "rules", "learn", "sessions")


def _num(x: Any) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def _iso_day(x: Any) -> bool:
    try:
        date.fromisoformat(str(x))
    except ValueError:
        return False
    return True


def _check_quotes(snap: dict[str, Any], plan_syms: set[str], errors: list[str]) -> None:
    quotes = snap["prices"].get("quotes")
    if not isinstance(quotes, dict):
        errors.append("prices.quotes is missing")
        return
    for sym, q in quotes.items():
        if not SYMBOL.fullmatch(str(sym)):
            errors.append(f"bad ticker {str(sym)[:12]!r}")
            continue
        close = q.get("close") if isinstance(q, dict) else None
        if not isinstance(close, (int, float)) or not _num(close) or close <= 0:
            errors.append(f"{sym}: price is missing or zero")
            continue
        prev = q.get("prev_close")
        if prev is not None and (not _num(prev) or prev <= 0):
            errors.append(f"{sym}: previous close is missing or zero")
        if not _iso_day(q.get("day")):
            errors.append(f"{sym}: price date is unreadable")
        chg = q.get("change_pct")
        if sym in plan_syms and chg is not None and abs(chg) > MAX_PLAN_DAY_MOVE_PCT:
            errors.append(f"{sym}: a {chg:+.0f}% one-day move looks like bad data")
    for sym in plan_syms:
        if sym not in quotes:
            errors.append(f"{sym}: no price for a plan holding")


def _check_history(snap: dict[str, Any], errors: list[str]) -> None:
    hist = snap["prices"].get("history") or {}
    days = hist.get("days", [])
    if days != sorted(days):
        errors.append("price history dates are out of order")
    for sym, closes in (hist.get("closes") or {}).items():
        if len(closes) != len(days):
            errors.append(f"{sym}: price history doesn't line up with its dates")
        elif any(c is not None and (not _num(c) or c <= 0) for c in closes):
            errors.append(f"{sym}: price history has a zero or broken value")


def _check_vs_previous(snap: dict[str, Any], previous: dict[str, Any] | None,
                       plan_syms: set[str], errors: list[str]) -> None:  # fmt: skip
    old = ((previous or {}).get("prices") or {}).get("quotes") or {}
    new = snap["prices"].get("quotes") or {}
    splits = ((snap["prices"].get("history") or {}).get("splits")) or {}
    for sym in plan_syms:
        a, b = old.get(sym), new.get(sym)
        if not (isinstance(a, dict) and isinstance(b, dict)) or sym in splits:
            continue
        if _num(a.get("close")) and _num(b.get("close")) and a["close"] > 0:
            ratio = b["close"] / a["close"]
            if ratio > MAX_RUN_TO_RUN_RATIO or ratio < 1 / MAX_RUN_TO_RUN_RATIO:
                errors.append(f"{sym}: price jumped from {a['close']:.2f} to {b['close']:.2f} "
                              "since the last update, with no split to explain it")  # fmt: skip


def validate(snap: Any, previous: dict[str, Any] | None = None) -> list[str]:
    if not isinstance(snap, dict):
        return ["snapshot is not an object"]
    errors = [f"missing section: {k}" for k in REQUIRED if k not in snap]
    if errors:
        return errors
    if snap["schema"] != 1:
        errors.append("unknown snapshot schema")
    try:
        if datetime.fromisoformat(str(snap["generated_at"])).tzinfo is None:
            errors.append("generated_at has no time zone")
    except ValueError:
        errors.append("generated_at is unreadable")
    result = (snap["mood"] or {}).get("result") or {}
    if result.get("mood") not in MOODS:
        errors.append("market mood is unreadable")
    targets = (snap["plan"] or {}).get("targets")
    if not isinstance(targets, list) or not targets:
        errors.append("the plan has no targets")
        targets = []
    total = sum(t.get("target_pct", 0) for t in targets if _num(t.get("target_pct")))
    if targets and abs(total - 100) > 0.05:
        errors.append(f"plan targets add up to {total:.2f}%, not 100%")
    cap = (snap["rules"] or {}).get("max_single_stock_pct", 10)
    for t in targets:
        if t.get("kind") == "stock" and _num(t.get("target_pct")) and t["target_pct"] > cap + 1e-6:
            errors.append(f"{t.get('symbol')}: target above the {cap}% single-company cap")
    plan_syms = {str(t.get("symbol")) for t in targets}
    if not isinstance(snap["prices"], dict):
        errors.append("prices section is unreadable")
        return errors
    _check_quotes(snap, plan_syms, errors)
    _check_history(snap, errors)
    _check_vs_previous(snap, previous, plan_syms, errors)
    sessions = snap["sessions"]
    if not isinstance(sessions, list) or not sessions:
        errors.append("market calendar is missing")
    return errors

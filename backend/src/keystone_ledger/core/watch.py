"""Quarterly check-ins on the company screen, anti-churn picking and affinity. Pure functions.

Once each calendar quarter the screen result for every company is recorded. A company that fails
in the latest check-in is "on watch"; one that failed the last N check-ins in a row (default 2) is
"replace": new money stops flowing to it. Nothing is ever sold.

Affinity: within the stock sleeve, companies whose business is getting stronger (growth plus
profit margin, from SEC filings) get a bigger share of new money; ones getting weaker, or on
watch, get less. Price moves never enter into it.
"""

from __future__ import annotations

import statistics
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from typing import Any, Literal

from keystone_ledger.core.screen import ScreenResult

WatchStatus = Literal["ok", "watch", "replace"]
Trend = Literal["improving", "steady", "weakening", "new"]

MAX_QUARTERS = 12  # three years of check-ins
TREND_PP = 2.0  # score change (percentage points) that counts as a real trend
AFFINITY_MIN, AFFINITY_MAX = 0.25, 2.0


def quarter_of(d: date) -> str:
    return f"{d.year}Q{(d.month - 1) // 3 + 1}"


def record_quarter(
    history: Sequence[Mapping[str, Any]], quarter: str, results: Sequence[ScreenResult]
) -> list[dict[str, Any]]:
    """Add (or, within the same quarter, replace) this quarter's check-in. Oldest first."""
    entry = {
        "quarter": quarter,
        "results": {r.symbol: {"pass": bool(r.qualifies), "score": r.score} for r in results},
    }
    kept = [dict(h) for h in history if h.get("quarter") != quarter]
    kept.append(entry)
    kept.sort(key=lambda h: str(h["quarter"]))
    return kept[-MAX_QUARTERS:]


def status_of(symbol: str, history: Sequence[Mapping[str, Any]], replace_after: int) -> WatchStatus:
    """Failed check-ins in a row, counting back from the latest one."""
    streak = 0
    for h in reversed(history):
        res = h["results"].get(symbol)
        if res is None or res["pass"]:
            break
        streak += 1
    if streak >= replace_after:
        return "replace"
    return "watch" if streak >= 1 else "ok"


def trend_of(symbol: str, history: Sequence[Mapping[str, Any]]) -> Trend:
    scores = [h["results"][symbol]["score"] for h in history
              if symbol in h["results"] and h["results"][symbol]["score"] is not None]  # fmt: skip
    if len(scores) < 2:
        return "new"
    delta = scores[-1] - scores[-2]
    if delta >= TREND_PP:
        return "improving"
    if delta <= -TREND_PP:
        return "weakening"
    return "steady"


def keep_list(previous_picks: Sequence[str], statuses: Mapping[str, WatchStatus]) -> list[str]:
    """Last time's picks stay picked unless they reached "replace" (stops churn)."""
    return [s for s in previous_picks if statuses.get(s, "ok") != "replace"]


@dataclass(frozen=True)
class Affinity:
    weight: float  # 1.0 = an equal share of the stock sleeve
    trend: Trend
    status: WatchStatus
    reason: str


def affinity(
    picks: Sequence[ScreenResult],
    statuses: Mapping[str, WatchStatus],
    trends: Mapping[str, Trend],
) -> dict[str, Affinity]:
    """Weight each pick by business quality vs the other picks, then by direction and status."""
    scored = [r.score for r in picks if r.score is not None and r.score > 0]
    mid = statistics.median(scored) if scored else None
    out: dict[str, Affinity] = {}
    for r in picks:
        st = statuses.get(r.symbol, "ok")
        tr = trends.get(r.symbol, "new")
        base = 1.0
        if mid and r.score is not None and r.score > 0:
            base = min(1.5, max(0.5, r.score / mid))
        reasons: list[str] = []
        if base >= 1.15:
            reasons.append("stronger growth and profit than most picks")
        elif base <= 0.85:
            reasons.append("less growth and profit than most picks")
        w = base
        if tr == "improving":
            w *= 1.2
            reasons.append("its business got stronger since last quarter")
        elif tr == "weakening":
            w *= 0.8
            reasons.append("its business got weaker since last quarter")
        if st == "watch":
            w *= 0.5
            reasons.append("it failed the latest quarterly check (on watch)")
        w = round(min(AFFINITY_MAX, max(AFFINITY_MIN, w)), 3)
        reason = "; ".join(reasons) if reasons else "in line with the other picks"
        out[r.symbol] = Affinity(w, tr, st, reason[0].upper() + reason[1:] + ".")
    return out

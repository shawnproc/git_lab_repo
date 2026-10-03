"""The growing wall: one stone per month you invested. Pure functions, no I/O, no clock.

Rows are calendar years (12 stones each). A month is "laid" when it has at least one logged
contribution. A year with all 12 months laid is crowned with a keystone.

Streaks:
* current: consecutive laid months ending this month, or ending last month if this month isn't
  laid yet (the month isn't over, so it doesn't break the streak).
* longest: the longest run of consecutive laid months ever.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date
from typing import Literal

StoneState = Literal["laid", "open", "missed", "future", "before_start"]

MONTH_NAMES = (
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
)  # fmt: skip


def month_start(d: date) -> date:
    return d.replace(day=1)


def add_months(d: date, n: int) -> date:
    idx = d.year * 12 + (d.month - 1) + n
    return date(idx // 12, idx % 12 + 1, 1)


def months_between(a: date, b: date) -> int:
    """Whole months from a to b (both month starts)."""
    return (b.year - a.year) * 12 + (b.month - a.month)


@dataclass(frozen=True)
class Stone:
    month: date
    label: str  # "March 2026"
    state: StoneState
    amount: float  # total logged that month (0 if none)
    entries: int


@dataclass(frozen=True)
class Course:
    """One row of the wall: a calendar year."""

    year: int
    stones: list[Stone]
    laid: int
    keystone: bool  # all 12 months laid
    total: float


@dataclass(frozen=True)
class WallView:
    courses: list[Course]  # newest year first (top of the wall)
    total: float
    months_laid: int
    current_streak: int
    longest_streak: int
    first_month: date | None
    this_month: date
    this_month_laid: bool
    keystones: int
    message: str


def _months(n: int) -> str:
    return f"{n} month{'' if n == 1 else 's'}"


def _message(v_laid: int, current: int, this_laid: bool, year_complete: bool) -> str:
    if v_laid == 0:
        return "Your wall is empty. Lay your first stone the next time you invest."
    if not this_laid:
        if current > 0:
            return (
                f"You've laid {_months(current)} in a row. Invest this month to keep the streak "
                "going."
            )
        return "No stone yet this month. Every month you invest adds one."
    if year_complete:
        return f"A full year! This row now has its keystone. {_months(current)} in a row."
    return f"This month's stone is laid. {_months(current)} in a row. Nicely done."


def build_wall(entries: Iterable[tuple[date, float]], this_month: date) -> WallView:
    this_month = month_start(this_month)
    totals: dict[date, float] = {}
    counts: dict[date, int] = {}
    for m, amount in entries:
        ms = month_start(m)
        if ms > this_month:
            continue  # never shows future stones as laid
        totals[ms] = totals.get(ms, 0.0) + amount
        counts[ms] = counts.get(ms, 0) + 1
    laid = sorted(totals)
    first = laid[0] if laid else None

    # Streaks
    longest = run = 0
    prev: date | None = None
    for m in laid:
        run = run + 1 if prev is not None and months_between(prev, m) == 1 else 1
        longest = max(longest, run)
        prev = m
    this_laid = this_month in totals
    cursor = this_month if this_laid else add_months(this_month, -1)
    current = 0
    while cursor in totals:
        current += 1
        cursor = add_months(cursor, -1)

    first_year = first.year if first else this_month.year
    courses: list[Course] = []
    for year in range(this_month.year, first_year - 1, -1):
        stones: list[Stone] = []
        for mi in range(1, 13):
            m = date(year, mi, 1)
            if m in totals:
                state: StoneState = "laid"
            elif m > this_month:
                state = "future"
            elif m == this_month:
                state = "open"
            elif first is not None and m < first:
                state = "before_start"
            else:
                state = "missed"
            stones.append(
                Stone(m, f"{MONTH_NAMES[mi - 1]} {year}", state, round(totals.get(m, 0.0), 2),
                      counts.get(m, 0))
            )  # fmt: skip
        n_laid = sum(s.state == "laid" for s in stones)
        courses.append(
            Course(year, stones, n_laid, n_laid == 12,
                   round(sum(s.amount for s in stones), 2))
        )  # fmt: skip
    keystones = sum(c.keystone for c in courses)
    return WallView(
        courses=courses,
        total=round(sum(totals.values()), 2),
        months_laid=len(laid),
        current_streak=current,
        longest_streak=longest,
        first_month=first,
        this_month=this_month,
        this_month_laid=this_laid,
        keystones=keystones,
        message=_message(len(laid), current, this_laid, bool(courses) and courses[0].keystone),
    )

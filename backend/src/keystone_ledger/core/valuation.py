"""Price check: is a company's price-to-earnings ratio well above its own usual level? Pure.

P/E = share price / earnings per share (EPS) from the SEC filings. "$30 per $1 of yearly profit".
We compare today's P/E (last close / latest full-year EPS) with the median of its year-end P/Es
over the past five years. Well above (`multiple` x the median) raises a flag. A flag never sells
anything and never blocks the plan: it only sends new buy-day money elsewhere for now.

Losses (EPS <= 0) make P/E meaningless, so those years are skipped and never guessed.

Stock splits: prices are split-adjusted but SEC earnings per share are as filed, and a later
filing may or may not restate earlier years. So only year-ends after the most recent split are
compared, and if a split came after the latest annual report, the check waits for the next one.
"""

from __future__ import annotations

import statistics
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import date

MIN_YEARS = 3  # year-end P/Es needed for a median worth comparing against


def _d(x: float) -> str:
    """Dollars per $1 of profit: one decimal under 10 so a small P/E never reads as $0."""
    return f"${x:.1f}" if x < 10 else f"${x:.0f}"


@dataclass(frozen=True)
class Valuation:
    pe: float | None  # today's P/E (None when the latest year was a loss)
    median_pe: float | None  # median year-end P/E over the years used
    years_used: list[int]
    eps_year: int | None
    flagged: bool
    detail: str  # one plain sentence


def valuation(
    eps: Mapping[int, float],
    year_end_close: Mapping[int, float],
    last_close: float | None,
    multiple: float,
    splits: Mapping[date, float] | None = None,
) -> Valuation:
    last_split = max(splits) if splits else None
    years = sorted(y for y in eps if y in year_end_close and eps[y] > 0 and year_end_close[y] > 0
                   and (last_split is None or date(y, 12, 31) >= last_split))  # fmt: skip
    history = {y: year_end_close[y] / eps[y] for y in years[-5:]}
    latest = max(eps) if eps else None
    if latest is None or last_close is None or last_close <= 0:
        return Valuation(None, None, [], latest, False, "No earnings data to check the price.")
    if last_split is not None and last_split > date(latest, 12, 31):
        wait = (
            f"It had a stock split on {last_split.isoformat()}, after its latest yearly "
            "report, so the price check waits for the next report instead of guessing."
        )
        return Valuation(None, None, [], latest, False, wait)
    if eps[latest] <= 0:
        lost = f"It lost money in {latest}, so price-to-earnings doesn't apply."
        return Valuation(None, None, sorted(history), latest, False, lost)
    pe = last_close / eps[latest]
    if len(history) < MIN_YEARS:
        why = "years since its last stock split" if last_split else "past years"
        return Valuation(round(pe, 1), None, sorted(history), latest, False,
                         f"It costs about {_d(pe)} per $1 of yearly profit; not enough {why} "
                         "to compare.")  # fmt: skip
    median = statistics.median(history.values())
    flagged = pe > median * multiple
    if flagged:
        detail = (
            f"It costs about {_d(pe)} per $1 of yearly profit, well above its usual "
            f"{_d(median)} (its {len(history)}-year median). New money goes elsewhere for now."
        )
    else:
        detail = (
            f"It costs about {_d(pe)} per $1 of yearly profit, near or below its usual "
            f"{_d(median)} (its {len(history)}-year median)."
        )
    return Valuation(round(pe, 1), round(median, 1), sorted(history), latest, flagged, detail)

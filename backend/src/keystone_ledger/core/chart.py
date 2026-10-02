"""Chart overlays and annotated events. Pure functions; every event uses only past data."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Literal

import pandas as pd

EventKind = Literal["golden_cross", "death_cross", "big_up", "big_down"]

BIG_MOVE_SIGMA = 3.0
BIG_MOVE_MIN_PCT = 3.0
VOL_WINDOW = 20


@dataclass(frozen=True)
class ChartEvent:
    day: date
    kind: EventKind
    price: float
    label: str
    explanation: str


def sma(close: pd.Series, n: int) -> pd.Series:
    """Simple moving average; NaN until `n` observations exist (never padded)."""
    return close.rolling(n, min_periods=n).mean()


def crossovers(close: pd.Series, fast: int = 50, slow: int = 200) -> list[ChartEvent]:
    f, s = sma(close, fast), sma(close, slow)
    diff = (f - s).dropna()
    sign = diff.gt(0)
    events: list[ChartEvent] = []
    for prev_day, day in zip(sign.index[:-1], sign.index[1:], strict=True):
        if sign[prev_day] == sign[day]:
            continue
        price = float(close[day])
        if sign[day]:
            events.append(
                ChartEvent(day, "golden_cross", price, "Golden cross",
                    f"The {fast}-day average rose above the {slow}-day average: the recent trend "
                    "turned stronger than the long-term one. Often read as a bullish sign, but it "
                    "lags price and gives false signals in choppy markets.")
            )  # fmt: skip
        else:
            events.append(
                ChartEvent(day, "death_cross", price, "Death cross",
                    f"The {fast}-day average fell below the {slow}-day average: the recent trend "
                    "weakened versus the long-term one. Often read as bearish, but it's a lagging "
                    "signal; many have been followed by recoveries.")
            )  # fmt: skip
    return events


def big_moves(close: pd.Series) -> list[ChartEvent]:
    """Days whose move is ≥ 3x the stock's typical daily move over the *previous* 20 days
    (and at least 3%), so a 3% day in a sleepy stock counts and one in a wild stock doesn't."""
    ret = close.pct_change()
    typical = ret.rolling(VOL_WINDOW, min_periods=VOL_WINDOW).std().shift(1)
    events: list[ChartEvent] = []
    for day in ret.index:
        r, t = ret[day], typical[day]
        if pd.isna(r) or pd.isna(t) or t <= 0:
            continue
        pct = float(r) * 100
        multiple = abs(float(r)) / float(t)
        if multiple < BIG_MOVE_SIGMA or abs(pct) < BIG_MOVE_MIN_PCT:
            continue
        up = pct > 0
        events.append(
            ChartEvent(day, "big_up" if up else "big_down", float(close[day]),
                f"{'+' if up else ''}{pct:.1f}% day",
                f"The price {'jumped' if up else 'fell'} {abs(pct):.1f}% in one day, about "
                f"{multiple:.0f} times its usual daily move over the prior {VOL_WINDOW} days. "
                "Big moves usually follow news (earnings, guidance, the economy); "
                "check what happened before reacting.")
        )  # fmt: skip
    return events

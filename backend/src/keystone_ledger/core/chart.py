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
                    f"The short-term trend line ({fast}-day average, about 2½ months) crossed "
                    f"ABOVE the long-term line ({slow}-day average, about 10 months). In plain "
                    "words: the stock's recent momentum turned stronger. People see this as a "
                    "good sign, but it shows up late and isn't a promise.")
            )  # fmt: skip
        else:
            events.append(
                ChartEvent(day, "death_cross", price, "Death cross",
                    f"The short-term trend line ({fast}-day average, about 2½ months) crossed "
                    f"BELOW the long-term line ({slow}-day average, about 10 months). In plain "
                    "words: the stock's recent momentum weakened. The name sounds scary, but "
                    "it shows up late and many stocks recover soon after. Information, not an "
                    "alarm.")
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
                f"Big {'jump' if up else 'drop'}: {'+' if up else ''}{pct:.1f}%",
                f"The price {'jumped' if up else 'dropped'} {abs(pct):.1f}% in one day. That's "
                f"about {multiple:.0f} times bigger than this stock's normal daily move over the "
                f"month before. Something usually happened (a profit report, news, the whole "
                "market moving). Read why before doing anything.")
        )  # fmt: skip
    return events

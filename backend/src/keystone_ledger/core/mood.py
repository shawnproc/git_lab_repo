"""Market mood: S&P 500 vs its long moving average, plus VIX. Pure function."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

import pandas as pd

from keystone_ledger.config import MoodConfig

Mood = Literal["green", "yellow", "red", "unknown"]


@dataclass(frozen=True)
class MoodResult:
    mood: Mood
    headline: str
    reasons: list[str]
    index_close: float | None
    index_ma: float | None
    vix: float | None


def market_mood(index_close: pd.Series, vix: float | None, cfg: MoodConfig) -> MoodResult:
    """Green: above MA and VIX calm. Red: below MA and VIX high. Otherwise yellow.

    `index_close` must be the index's closes in date order. Not enough history, or no VIX,
    gives "unknown"; we never guess.
    """
    closes = index_close.dropna()
    if len(closes) < cfg.ma_days or vix is None:
        missing = []
        if len(closes) < cfg.ma_days:
            missing.append(f"Need {cfg.ma_days} days of S&P 500 prices; have {len(closes)}.")
        if vix is None:
            missing.append("No VIX (fear gauge) reading yet.")
        return MoodResult("unknown", "Not enough data yet. Click \"Refresh prices\" to load it.",
                          missing, None, None, vix)  # fmt: skip
    last = float(closes.iloc[-1])
    ma = float(closes.iloc[-cfg.ma_days :].mean())
    above = last > ma
    gap = abs(last / ma - 1) * 100
    months = round(cfg.ma_days / 21)
    trend = (
        f"Direction: the S&P 500 (the 500 biggest US companies) is {gap:.1f}% "
        f"{'above' if above else 'below'} its average price over the last ~{months} months, "
        f"so the market has been trending {'up' if above else 'down'}."
    )
    if vix < cfg.vix_green_below:
        fear = (
            f'Nerves: the VIX "fear gauge" is {vix:.1f}, which is calm '
            f"(under {cfg.vix_green_below:g})."
        )
    elif vix > cfg.vix_red_above:
        fear = (
            f'Nerves: the VIX "fear gauge" is {vix:.1f}, which is scared '
            f"(over {cfg.vix_red_above:g}). Expect big daily swings."
        )
    else:
        fear = (
            f'Nerves: the VIX "fear gauge" is {vix:.1f}, somewhat nervous '
            f"(between {cfg.vix_green_below:g} and {cfg.vix_red_above:g})."
        )
    if above and vix < cfg.vix_green_below:
        mood: Mood = "green"
        headline = "Calm and rising. Business as usual: keep adding money on your normal schedule."
    elif not above and vix > cfg.vix_red_above:
        mood = "red"
        headline = (
            "Falling and fearful. Don't panic-sell. Long-term investors usually do best by "
            "sticking to the plan; prices are lower, so your monthly money buys more."
        )
    else:
        mood = "yellow"
        headline = "Mixed signals. Nothing to do differently: keep adding money on schedule."
    return MoodResult(mood, headline, [trend, fear], last, ma, vix)

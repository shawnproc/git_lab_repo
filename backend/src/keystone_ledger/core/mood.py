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
            missing.append(f"need {cfg.ma_days} days of S&P 500 closes, have {len(closes)}")
        if vix is None:
            missing.append("no VIX reading")
        return MoodResult("unknown", "Not enough data to judge the market", missing, None, None,
                          vix)  # fmt: skip
    last = float(closes.iloc[-1])
    ma = float(closes.iloc[-cfg.ma_days :].mean())
    above = last > ma
    gap = (last / ma - 1) * 100
    trend = (
        f"The S&P 500 ({last:,.0f}) is {abs(gap):.1f}% {'above' if above else 'below'} its "
        f"{cfg.ma_days}-day average ({ma:,.0f})."
    )
    if vix < cfg.vix_green_below:
        fear = f"VIX is {vix:.1f}, calm (under {cfg.vix_green_below:g})."
    elif vix > cfg.vix_red_above:
        fear = f"VIX is {vix:.1f}, fearful (over {cfg.vix_red_above:g})."
    else:
        fear = f"VIX is {vix:.1f}, somewhat nervous."
    if above and vix < cfg.vix_green_below:
        mood: Mood = "green"
        headline = "Calm uptrend: business as usual for long-term investing"
    elif not above and vix > cfg.vix_red_above:
        mood = "red"
        headline = "Downtrend with high fear: stick to the plan, don't panic-sell"
    else:
        mood = "yellow"
        headline = "Mixed signals: keep contributing on schedule"
    return MoodResult(mood, headline, [trend, fear], last, ma, vix)

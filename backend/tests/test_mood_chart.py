from __future__ import annotations

from datetime import date, timedelta

import numpy as np
import pandas as pd
import pytest

from keystone_ledger.config import MoodConfig
from keystone_ledger.core.chart import big_moves, crossovers, sma
from keystone_ledger.core.mood import market_mood

CFG = MoodConfig()


def _series(values: list[float]) -> pd.Series:
    start = date(2025, 1, 1)
    return pd.Series(values, index=[start + timedelta(days=i) for i in range(len(values))])


@pytest.mark.parametrize(
    ("last", "vix", "mood"),
    [
        (120.0, 15.0, "green"),
        (120.0, 25.0, "yellow"),
        (120.0, 35.0, "yellow"),  # uptrend but fearful
        (80.0, 15.0, "yellow"),  # downtrend but calm
        (80.0, 35.0, "red"),
    ],
)
def test_mood(last: float, vix: float, mood: str) -> None:
    res = market_mood(_series([100.0] * 199 + [last]), vix, CFG)
    assert res.mood == mood
    assert len(res.reasons) == 2
    assert res.index_ma == pytest.approx((100 * 199 + last) / 200)


def test_mood_unknown_without_enough_data() -> None:
    assert market_mood(_series([100.0] * 150), 15.0, CFG).mood == "unknown"
    assert market_mood(_series([100.0] * 250), None, CFG).mood == "unknown"


def test_sma_known_values_and_no_padding() -> None:
    s = sma(_series([1, 2, 3, 4, 5]), 3)
    assert s.isna().sum() == 2
    assert list(s.dropna()) == [2.0, 3.0, 4.0]


def test_crossovers() -> None:
    # Long flat, then a rally (golden cross), then a crash (death cross).
    vals = [100.0] * 210 + [100 + i for i in range(1, 80)] + [179 - 3 * i for i in range(1, 60)]
    ev = crossovers(_series(vals))
    assert [e.kind for e in ev] == ["golden_cross", "death_cross"]
    assert "crossed ABOVE the long-term line" in ev[0].explanation
    assert "crossed BELOW" in ev[1].explanation


def test_big_moves_use_only_prior_volatility() -> None:
    rng = np.random.default_rng(1)
    rets = list(rng.normal(0, 0.005, 60))
    rets[40] = 0.08  # +8% day in a calm stock
    rets[50] = 0.012  # +1.2%: well above sigma multiple? below 3% floor -> ignored
    prices = list(100 * np.cumprod(1 + np.array(rets)))
    ev = big_moves(_series(prices))
    assert len(ev) == 1
    assert ev[0].kind == "big_up"
    assert ev[0].label == "Big jump: +8.0%"
    assert "times bigger than this stock's normal daily move" in ev[0].explanation

from __future__ import annotations

from datetime import date

from keystone_ledger.data.base import RateLimitedError
from keystone_ledger.data.service import MarketDataService

from .conftest import FakeClock, FakeMacroProvider, FakePriceProvider


def test_first_fetch_pulls_full_history(
    market: MarketDataService, prices: FakePriceProvider
) -> None:
    res = market.get_bars("SPY")
    assert len(prices.calls) == 1
    _, start, end = prices.calls[0]
    assert start == date(2023, 10, 2)  # history_years=3 in fixture
    assert end == date(2026, 10, 2)
    assert res.freshness.stale is False
    assert res.freshness.last_day == date(2026, 10, 2)
    assert res.freshness.source == "fake_prices"


def test_fresh_cache_does_not_refetch(market: MarketDataService, prices: FakePriceProvider) -> None:
    market.get_bars("SPY")
    market.get_bars("SPY")
    market.get_bars("SPY")
    assert len(prices.calls) == 1


def test_incremental_fetch_when_behind(
    market: MarketDataService, prices: FakePriceProvider, clock: FakeClock
) -> None:
    market.get_bars("SPY")
    clock.advance(days=3)  # Monday 2026-10-05 after close
    res = market.get_bars("SPY")
    assert len(prices.calls) == 2
    _, start, _ = prices.calls[1]
    assert start == date(2026, 9, 22)  # last_day - 10 day overlap
    assert res.freshness.last_day == date(2026, 10, 5)
    assert not res.freshness.stale


def test_publication_lag_is_stale_and_rechecks_politely(
    market: MarketDataService, prices: FakePriceProvider, clock: FakeClock
) -> None:
    prices.available_through = date(2026, 10, 1)
    res = market.get_bars("SPY")
    assert res.freshness.stale
    assert "1 session(s) behind" in res.freshness.reason
    clock.advance(minutes=10)
    market.get_bars("SPY")
    assert len(prices.calls) == 1  # within recheck window: no hammering
    clock.advance(minutes=25)
    prices.available_through = None
    res = market.get_bars("SPY")
    assert len(prices.calls) == 2
    assert not res.freshness.stale


def test_failure_backoff_and_surface(
    market: MarketDataService, prices: FakePriceProvider, clock: FakeClock
) -> None:
    prices.fail = RateLimitedError("fake: rate limited")
    res = market.get_bars("SPY")
    assert res.freshness.stale
    assert res.freshness.last_error == "fake: rate limited"
    market.get_bars("SPY")
    assert len(prices.calls) == 1  # backing off
    clock.advance(minutes=16)
    prices.fail = None
    res = market.get_bars("SPY")
    assert len(prices.calls) == 2
    assert not res.freshness.stale
    assert res.freshness.last_error == ""


def test_dividend_adjustment_triggers_full_refetch(
    market: MarketDataService, prices: FakePriceProvider, clock: FakeClock
) -> None:
    market.get_bars("SPY")
    clock.advance(days=3)
    prices.adj_factor = 0.97  # new dividend => every historical adj_close changes
    res = market.get_bars("SPY")
    assert len(prices.calls) == 3
    assert prices.calls[2][1] == date(2023, 10, 5)
    first = res.bars.iloc[0]
    assert abs(first["adj_close"] / first["close"] - 0.97) < 1e-9


def test_macro_lag_tolerance(
    market: MarketDataService, macro: FakeMacroProvider, clock: FakeClock
) -> None:
    macro.lag_sessions = 1
    res = market.get_series("VIXCLS")
    assert res.freshness.last_day == date(2026, 10, 1)
    assert not res.freshness.stale
    clock.advance(days=3)
    macro.lag_sessions = 3
    res = market.get_series("VIXCLS")
    assert res.freshness.stale

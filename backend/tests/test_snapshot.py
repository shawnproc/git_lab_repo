from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import date
from typing import Any

import httpx
import pandas as pd
import pytest

from keystone_ledger.config import AppConfig
from keystone_ledger.data.base import ProviderError
from keystone_ledger.data.calendar import MarketCalendar
from keystone_ledger.tools.snapshot import build_snapshot, learn_section, publish, report
from keystone_ledger.tools.validate_snapshot import validate

from .conftest import FakeClock, FakeFundamentalsProvider, FakePriceProvider


@dataclass
class FakeFred:
    calendar: MarketCalendar
    name: str = "fake_fred"
    fail: bool = False
    lag: int = 1
    calls: list[str] = field(default_factory=list)

    def fetch_series(self, series_id: str, start: date, end: date) -> pd.Series:
        self.calls.append(series_id)
        if self.fail:
            raise ProviderError("fred: HTTP 503")
        days = self.calendar.sessions_between(start, end)
        days = days[: len(days) - self.lag]
        if series_id == "SP500":
            values = [5000.0 + i for i in range(len(days))]  # steady uptrend
        else:
            values = [14.0] * len(days)  # calm
        return pd.Series(values, index=days, dtype=float)


def _snap(
    clock: FakeClock,
    fred: FakeFred,
    sec: FakeFundamentalsProvider,
    previous: dict[str, Any] | None = None,
    prices: FakePriceProvider | None = None,
) -> dict[str, Any]:
    return build_snapshot(cfg=AppConfig(), fred=fred, sec=sec, calendar=MarketCalendar(),
                          prices=prices, previous=previous, clock=clock)  # fmt: skip


@dataclass
class FlakyPrices(FakePriceProvider):
    """Fails for the listed symbols only."""

    broken: tuple[str, ...] = ()

    def fetch_daily_bars(self, symbol: str, start: date, end: date) -> pd.DataFrame:
        if symbol in self.broken:
            raise ProviderError(f"yfinance: no data for {symbol}")
        return super().fetch_daily_bars(symbol, start, end)


def test_snapshot_has_mood_plan_and_only_public_data(
    clock: FakeClock, calendar: MarketCalendar
) -> None:
    snap = _snap(clock, FakeFred(calendar), FakeFundamentalsProvider())
    text = json.dumps(snap)  # must be plain JSON
    assert snap["mood"]["result"]["mood"] == "green"
    assert snap["mood"]["stale"] is False  # one-session FRED lag is expected
    assert snap["mood"]["index_day"] == "2026-10-01"
    targets = {t["symbol"]: t for t in snap["plan"]["targets"]}
    assert set(targets) == {"VTI", "VXUS", "NVDA", "MSFT", "LLY", "KO"}
    assert targets["VTI"]["name"] == "Vanguard Morningstar Total Stock Market ETF"
    assert sum(t["target_pct"] for t in snap["plan"]["targets"]) == pytest.approx(100)
    assert snap["plan"]["stale"] is False
    assert snap["rules"]["drift"] == {"max_abs_pp": 5.0, "max_relative_pct": 25.0}
    # Only public sections, and nothing that looks like an email address (the SEC contact).
    assert set(snap) == {
        "schema", "app_version", "generated_at", "mood", "plan", "prices", "rules", "learn",
        "overlap", "screen_history", "sessions",
    }  # fmt: skip
    assert not re.search(r"[\w.+-]+@[\w-]+\.[\w.]+", text)


def test_failed_fetch_carries_previous_section_marked_stale(
    clock: FakeClock, calendar: MarketCalendar
) -> None:
    good = _snap(clock, FakeFred(calendar), FakeFundamentalsProvider())
    sec = FakeFundamentalsProvider(fail=ProviderError("sec: HTTP 429"))
    bad = _snap(clock, FakeFred(calendar, fail=True), sec, previous=good)
    assert bad["mood"]["stale"] is True
    assert bad["mood"]["result"] == good["mood"]["result"]  # last good data, not invented
    assert "fred: HTTP 503" in bad["mood"]["reason"]
    assert bad["plan"]["stale"] is True
    assert bad["plan"]["targets"] == good["plan"]["targets"]
    assert bad["plan"]["last_error"] == "sec: HTTP 429"


def test_first_run_failure_is_unknown_not_guessed(
    clock: FakeClock, calendar: MarketCalendar
) -> None:
    snap = _snap(
        clock, FakeFred(calendar, fail=True), FakeFundamentalsProvider(fail=ProviderError("x"))
    )
    assert snap["mood"]["result"]["mood"] == "unknown"
    assert snap["mood"]["stale"] is True
    assert snap["plan"]["stale"] is True
    assert {t["kind"] for t in snap["plan"]["targets"]} == {"core"}  # no picks without reports


def test_old_fred_data_is_flagged(clock: FakeClock, calendar: MarketCalendar) -> None:
    snap = _snap(clock, FakeFred(calendar, lag=4), FakeFundamentalsProvider())
    assert snap["mood"]["stale"] is True
    assert "older than expected" in snap["mood"]["reason"]


def test_learn_section_stamps_links_that_open() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200 if "investor.gov" in str(req.url) else 404)

    out = learn_section(True, httpx.Client(transport=httpx.MockTransport(handler)))
    assert out["links"]
    assert all("investor.gov" in link["url"] for link in out["links"])
    assert out["pending_links"] > 0


def test_prices_for_every_plan_ticker(clock: FakeClock, calendar: MarketCalendar) -> None:
    prices = FakePriceProvider(calendar)
    snap = _snap(clock, FakeFred(calendar), FakeFundamentalsProvider(), prices=prices)
    p = snap["prices"]
    assert {t["symbol"] for t in snap["plan"]["targets"]} <= set(p["quotes"])
    cfg = AppConfig()
    public = {"VTI", "VXUS", *cfg.plan.candidates, *cfg.data.extra_tickers}
    assert set(p["quotes"]) == public  # config lists only: nothing personal
    assert len(public) > 100  # broad, so the list doesn't hint at anyone's holdings
    assert p["stale"] is False and p["missing"] == [] and p["source"] == "fake_prices"
    q = p["quotes"]["VTI"]
    assert q["change_pct"] == pytest.approx((q["close"] / q["prev_close"] - 1) * 100, abs=1e-3)
    assert snap["mood"]["source"].startswith("FRED")  # Yahoo only when FRED fails
    assert not any(c[0].startswith("^") for c in prices.calls)


def test_missing_ticker_is_listed_not_filled(clock: FakeClock, calendar: MarketCalendar) -> None:
    prices = FlakyPrices(calendar, broken=("KO",))
    snap = _snap(clock, FakeFred(calendar), FakeFundamentalsProvider(), prices=prices)
    p = snap["prices"]
    assert "KO" not in p["quotes"] and p["missing"] == ["KO"]
    assert p["stale"] is True and "no price for KO" in p["reason"]
    assert "yfinance: no data for KO" in p["last_error"]


def test_all_prices_fail_carries_previous(clock: FakeClock, calendar: MarketCalendar) -> None:
    good = _snap(clock, FakeFred(calendar), FakeFundamentalsProvider(),
                 prices=FakePriceProvider(calendar))  # fmt: skip
    bad = _snap(clock, FakeFred(calendar), FakeFundamentalsProvider(), previous=good,
                prices=FakePriceProvider(calendar, fail=ProviderError("yfinance: blocked")))  # fmt: skip
    assert bad["prices"]["quotes"] == good["prices"]["quotes"]
    assert bad["prices"]["stale"] is True and "yfinance: blocked" in bad["prices"]["reason"]


def test_mood_falls_back_to_yahoo_when_fred_fails(
    clock: FakeClock, calendar: MarketCalendar
) -> None:
    prices = FakePriceProvider(calendar)
    snap = _snap(clock, FakeFred(calendar, fail=True), FakeFundamentalsProvider(), prices=prices)
    m = snap["mood"]
    assert m["source"].startswith("Yahoo Finance") and m["result"]["mood"] != "unknown"
    assert "fred: HTTP 503" in m["last_error"]  # the FRED failure is still reported
    assert {"^GSPC", "^VIX"} <= {c[0] for c in prices.calls}


def test_no_source_at_all_says_why(clock: FakeClock, calendar: MarketCalendar) -> None:
    prices = FakePriceProvider(calendar, fail=ProviderError("yfinance: blocked"))
    snap = _snap(clock, FakeFred(calendar, fail=True), FakeFundamentalsProvider(), prices=prices)
    assert snap["mood"]["result"]["mood"] == "unknown"
    assert (
        "fred: HTTP 503" in snap["mood"]["reason"] and "yfinance: blocked" in snap["mood"]["reason"]
    )


def test_report_lists_each_part_and_ticker(clock: FakeClock, calendar: MarketCalendar) -> None:
    snap = _snap(clock, FakeFred(calendar), FakeFundamentalsProvider(),
                 prices=FlakyPrices(calendar, broken=("KO",)))  # fmt: skip
    text = report(snap)
    assert "| Market mood | ✅ fresh |" in text
    assert "| Ticker prices | ⚠️ stale |" in text and "no price for KO" in text
    assert "| VTI |" in text


@dataclass
class GappyPrices(FakePriceProvider):
    """VXUS skips one session (a halt), to prove gaps stay gaps."""

    gap: date = date(2026, 9, 15)

    def fetch_daily_bars(self, symbol: str, start: date, end: date) -> pd.DataFrame:
        df = super().fetch_daily_bars(symbol, start, end)
        return df.drop(index=[self.gap]) if symbol == "VXUS" else df


def test_history_has_a_year_of_closes_and_never_fills_gaps(
    clock: FakeClock, calendar: MarketCalendar
) -> None:
    prices = GappyPrices(calendar)
    snap = _snap(clock, FakeFred(calendar), FakeFundamentalsProvider(), prices=prices)
    h = snap["prices"]["history"]
    assert h["days"][0] <= "2025-10-02" and h["days"][-1] == "2026-10-02"
    assert h["days"] == sorted(h["days"])
    for sym, closes in h["closes"].items():
        assert len(closes) == len(h["days"]), sym
    i = h["days"].index("2026-09-15")
    assert h["closes"]["VXUS"][i] is None  # not interpolated
    assert h["closes"]["VTI"][i] is not None
    assert h["closes"]["VTI"][-1] == snap["prices"]["quotes"]["VTI"]["close"]
    assert len(json.dumps(snap)) < 1_000_000  # small enough for a phone on cellular


def test_a_non_plan_ticker_failing_does_not_mark_prices_stale(
    clock: FakeClock, calendar: MarketCalendar
) -> None:
    prices = FlakyPrices(calendar, broken=("NKE",))  # on the company list, not picked
    snap = _snap(clock, FakeFred(calendar), FakeFundamentalsProvider(), prices=prices)
    assert snap["prices"]["stale"] is False
    assert "NKE" in snap["prices"]["missing"] and "NKE" not in snap["prices"]["history"]["closes"]


@dataclass
class SplittingPrices(FakePriceProvider):
    """Reports a 10-for-1 NVDA split, like YFinanceProvider.fetch_history."""

    def fetch_history(
        self, symbol: str, start: date, end: date
    ) -> tuple[pd.DataFrame, dict[date, float], dict[date, float]]:
        bars = self.fetch_daily_bars(symbol, start, end)
        return bars, ({date(2026, 6, 10): 10.0} if symbol == "NVDA" else {}), {}


def test_history_carries_splits_for_the_phone(clock: FakeClock, calendar: MarketCalendar) -> None:
    snap = _snap(clock, FakeFred(calendar), FakeFundamentalsProvider(),
                 prices=SplittingPrices(calendar))  # fmt: skip
    assert snap["prices"]["history"]["splits"] == {"NVDA": [["2026-06-10", 10.0]]}


def _prev_with(picks: list[str], failed_last_quarter: list[str]) -> dict[str, Any]:
    """A previous snapshot whose plan picked `picks`, with last quarter's check-in."""
    return {
        "schema": 1,
        "plan": {"targets": [{"symbol": s, "kind": "stock"} for s in picks]},
        "screen_history": [
            {
                "quarter": "2026Q3",
                "results": {
                    s: {"pass": s not in failed_last_quarter, "score": 30.0} for s in picks
                },
            }
        ],
    }


def test_a_pick_that_fails_once_stays_on_watch(clock: FakeClock, calendar: MarketCalendar) -> None:
    # ORCL fails the debt check today. It was picked last time and passed last quarter.
    snap = _snap(clock, FakeFred(calendar), FakeFundamentalsProvider(),
                 previous=_prev_with(["ORCL", "NVDA"], failed_last_quarter=[]))  # fmt: skip
    t = {x["symbol"]: x for x in snap["plan"]["targets"]}
    assert "ORCL" in t and t["ORCL"]["status"] == "watch"  # kept: no churn after one bad report
    assert t["ORCL"]["weight"] < t["NVDA"]["weight"]  # but it gets less new money
    assert snap["plan"]["watch"]["ORCL"] == "watch"
    assert snap["screen_history"][-1]["quarter"] == "2026Q4"


def test_two_failed_quarters_in_a_row_replaces_it(
    clock: FakeClock, calendar: MarketCalendar
) -> None:
    snap = _snap(clock, FakeFred(calendar), FakeFundamentalsProvider(),
                 previous=_prev_with(["ORCL", "NVDA"], failed_last_quarter=["ORCL"]))  # fmt: skip
    syms = {x["symbol"] for x in snap["plan"]["targets"]}
    assert "ORCL" not in syms  # new money stops; nothing is sold
    assert snap["plan"]["watch"]["ORCL"] == "replace"


def test_picks_get_a_price_check_and_affinity(clock: FakeClock, calendar: MarketCalendar) -> None:
    snap = _snap(clock, FakeFred(calendar), FakeFundamentalsProvider(),
                 prices=FakePriceProvider(calendar))  # fmt: skip
    stocks = [x for x in snap["plan"]["targets"] if x["kind"] == "stock"]
    assert stocks and all("valuation" in x and "weight" in x for x in stocks)
    v = stocks[0]["valuation"]
    assert v["pe"] is not None and len(v["years_used"]) >= 3  # 6 years of fake prices
    assert isinstance(v["flagged"], bool) and "per $1 of yearly profit" in v["detail"]
    assert sum(x["target_pct"] for x in snap["plan"]["targets"]) == pytest.approx(100)
    core = [x for x in snap["plan"]["targets"] if x["kind"] == "core"]
    assert {x["base_pct"] for x in core} == {45.0, 15.0}


def test_sessions_and_overlap_are_published(clock: FakeClock, calendar: MarketCalendar) -> None:
    @dataclass
    class WithHoldings(FakePriceProvider):
        def fetch_top_holdings(self, symbol: str) -> list[tuple[str, float]]:
            return [("NVDA", 6.5), ("MSFT", 6.0)]

    snap = _snap(clock, FakeFred(calendar), FakeFundamentalsProvider(),
                 prices=WithHoldings(calendar))  # fmt: skip
    days = [s["day"] for s in snap["sessions"]]
    assert "2026-10-02" in days and "2026-10-03" not in days  # Saturday
    assert snap["sessions"][0]["close"].endswith("+00:00")
    assert snap["overlap"]["top"][0] == {"symbol": "NVDA", "weight_pct": 6.5}
    assert snap["overlap"]["fund"] == "VTI"


# --- never publish bad data -----------------------------------------------------------------


def _good(clock: FakeClock, calendar: MarketCalendar) -> dict[str, Any]:
    return _snap(clock, FakeFred(calendar), FakeFundamentalsProvider(),
                 prices=FakePriceProvider(calendar))  # fmt: skip


def test_a_good_snapshot_validates(clock: FakeClock, calendar: MarketCalendar) -> None:
    assert validate(_good(clock, calendar)) == []


@pytest.mark.parametrize(
    ("mutate", "expect"),
    [
        (lambda s: s["prices"]["quotes"]["VTI"].update(close=0), "VTI: price is missing or zero"),
        (lambda s: s["prices"]["quotes"]["VTI"].update(close=None), "VTI: price is missing"),
        (lambda s: s["prices"]["quotes"].pop("VXUS"), "VXUS: no price for a plan holding"),
        (lambda s: s["prices"]["quotes"]["VTI"].update(change_pct=-70.0), "-70% one-day move"),
        (lambda s: s["plan"]["targets"][0].update(target_pct=99.0), "not 100%"),
        (lambda s: s.pop("sessions"), "missing section: sessions"),
        (lambda s: s["prices"]["history"]["closes"]["VTI"].append(1.0), "doesn't line up"),
        (lambda s: s.update(generated_at="yesterday"), "generated_at is unreadable"),
    ],
)
def test_bad_snapshots_are_caught(clock: FakeClock, calendar: MarketCalendar,
                                  mutate: Any, expect: str) -> None:  # fmt: skip
    snap = _good(clock, calendar)
    mutate(snap)
    assert any(expect in e for e in validate(snap)), validate(snap)


def test_run_to_run_jump_without_a_split_is_caught(clock: FakeClock,
                                                    calendar: MarketCalendar) -> None:  # fmt: skip
    prev = _good(clock, calendar)
    new = json.loads(json.dumps(prev))
    new["prices"]["quotes"]["VTI"]["close"] *= 3
    assert any("jumped" in e for e in validate(new, prev))


def test_publish_keeps_the_last_good_file_and_writes_an_error_status(
    tmp_path: Any, clock: FakeClock, calendar: MarketCalendar
) -> None:
    good = _good(clock, calendar)
    bad = json.loads(json.dumps(good))
    bad["generated_at"] = "2026-10-05T23:00:00+00:00"
    bad["prices"]["quotes"]["VTI"]["close"] = 0
    out = tmp_path / "snapshot.json"
    status = publish(bad, good, out, clock())
    assert status["ok"] is False and status["kept_previous"] is True
    assert json.loads(out.read_text())["generated_at"] == good["generated_at"]  # last good kept
    on_disk = json.loads((tmp_path / "status.json").read_text())
    assert on_disk["ok"] is False and any("VTI" in e for e in on_disk["errors"])
    assert on_disk["published_generated_at"] == good["generated_at"]
    ok = publish(good, None, out, clock())
    assert ok["ok"] is True and json.loads((tmp_path / "status.json").read_text())["ok"] is True

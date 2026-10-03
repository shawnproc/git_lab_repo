from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import date

import httpx
import pandas as pd
import pytest

from keystone_ledger.config import AppConfig
from keystone_ledger.data.base import ProviderError
from keystone_ledger.data.calendar import MarketCalendar
from keystone_ledger.tools.snapshot import build_snapshot, learn_section

from .conftest import FakeClock, FakeFundamentalsProvider


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


def _snap(clock: FakeClock, fred: FakeFred, sec: FakeFundamentalsProvider, previous=None):  # type: ignore[no-untyped-def]
    return build_snapshot(cfg=AppConfig(), fred=fred, sec=sec, calendar=MarketCalendar(),
                          previous=previous, clock=clock)  # fmt: skip


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
    assert set(snap) == {"schema", "app_version", "generated_at", "mood", "plan", "rules", "learn"}
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

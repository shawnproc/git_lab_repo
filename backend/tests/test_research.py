from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import pandas as pd
import pytest

from keystone_ledger.config import AppConfig, DataConfig
from keystone_ledger.data.base import ProviderError
from keystone_ledger.data.calendar import MarketCalendar
from keystone_ledger.data.fundamentals import FundamentalsService
from keystone_ledger.data.ratelimit import MinIntervalLimiter
from keystone_ledger.data.yfinance_provider import BatchHistory, YFinanceProvider, parse_batch
from keystone_ledger.db.session import init_schema, make_engine, make_session_factory
from keystone_ledger.tools.research import build_research, validate_research, write_research

from .conftest import FakeClock, FakeFundamentalsProvider


@dataclass
class FakeBatchPrices:
    """Daily closes for any ticker: $100 rising $0.05 a session, so P/Es are known."""

    calendar: MarketCalendar
    name: str = "fake_batch"
    calls: list[list[str]] = field(default_factory=list)
    broken: tuple[str, ...] = ()
    splits: dict[str, dict[date, float]] = field(default_factory=dict)

    def fetch_batch(
        self, symbols: list[str], start: date, end: date, interval: str = "1d"
    ) -> dict[str, BatchHistory]:
        self.calls.append(symbols)
        if any(s in self.broken for s in symbols):
            raise ProviderError("yfinance: batch failed (HTTPError)")
        days = self.calendar.sessions_between(start, end)
        closes = pd.Series([100 + i * 0.05 for i in range(len(days))], index=days, dtype=float)
        divs = {days[-30]: 0.5}
        return {s: BatchHistory(closes, self.splits.get(s, {}), divs) for s in symbols}


def _svc(clock: FakeClock) -> FundamentalsService:
    engine = make_engine(None)
    init_schema(engine)
    svc = FundamentalsService(make_session_factory(engine), FakeFundamentalsProvider(),
                              timedelta(days=1), clock)  # fmt: skip
    svc.refresh(["AAPL"], force=True, all_companies=True)
    return svc


def _cfg(floor: float = 1e9) -> AppConfig:
    return AppConfig(data=DataConfig(research_min_revenue_usd=floor))


def _build(clock: FakeClock, prices: Any, floor: float = 1e9,
           funds: dict[str, Any] | None = None) -> dict[str, Any]:  # fmt: skip
    return build_research(clock.now, date(2026, 10, 2), _svc(clock), _cfg(floor), prices,
                          funds or {})  # fmt: skip


def test_every_big_company_gets_a_verdict_not_just_the_plan(
    clock: FakeClock, calendar: MarketCalendar
) -> None:
    r = _build(clock, FakeBatchPrices(calendar))
    assert not validate_research(r)
    by = {c["s"]: c for c in r["companies"]}
    # all_companies kept every filer, not only the one we asked for (AAPL)
    assert {"AAPL", "MSFT", "ORCL", "NKE", "OTHER"} <= set(by)
    assert by["ORCL"]["v"] == "no" and "debt" in by["ORCL"]["h"].lower()
    assert by["AAPL"]["v"] in ("fit", "pricey")
    assert all(len(c["checks"]) == 5 for c in by.values())
    assert by["AAPL"]["close"] > 0 and by["AAPL"]["day"] == "2026-10-02"
    assert by["AAPL"]["dy"] is not None  # a $0.50 dividend in the last year
    assert r["verdicts"]["no"] == "Not a fit"


def test_small_companies_are_left_out(clock: FakeClock, calendar: MarketCalendar) -> None:
    r = _build(clock, FakeBatchPrices(calendar), floor=100e9)
    syms = {c["s"] for c in r["companies"]}
    assert "AAPL" in syms and "OTHER" not in syms and "NKE" not in syms


def test_failed_price_batch_leaves_prices_empty_never_guessed(
    clock: FakeClock, calendar: MarketCalendar
) -> None:
    r = _build(clock, FakeBatchPrices(calendar, broken=("AAPL",)))
    aapl = next(c for c in r["companies"] if c["s"] == "AAPL")
    assert aapl["close"] is None and aapl["chg"] is None and aapl["pe"] is None
    assert aapl["v"] in ("fit", "pricey")  # the business checks still stand on their own
    assert r["errors"] and "batch failed" in r["errors"][0]


def test_a_recent_split_makes_the_price_check_wait(
    clock: FakeClock, calendar: MarketCalendar
) -> None:
    prices = FakeBatchPrices(calendar, splits={"MSFT": {date(2026, 6, 1): 4.0}})
    msft = next(c for c in _build(clock, prices)["companies"] if c["s"] == "MSFT")
    assert msft["pe"] is None and "stock split" in msft["pe_note"]


def test_funds_show_price_only(clock: FakeClock, calendar: MarketCalendar) -> None:
    quotes = {"VTI": {"close": 300.0, "change_pct": 0.5, "day": "2026-10-02"},
              "AAPL": {"close": 1.0}, "^GSPC": {"close": 5000.0},
              "BABA": {"close": 120.0}}  # fmt: skip
    r = _build(clock, FakeBatchPrices(calendar), funds=quotes)
    by = {c["s"]: c for c in r["companies"]}
    assert by["VTI"]["v"] == "fund" and by["VTI"]["close"] == 300.0
    assert by["AAPL"]["v"] != "fund"  # a company is never shown as a fund
    assert "^GSPC" not in by
    # A stock with no SEC numbers we can read is "price only", never mislabeled as a fund.
    assert by["BABA"]["v"] == "unknown" and "Price only" in by["BABA"]["h"]


def test_trading_day_still_open_is_never_used(clock: FakeClock, calendar: MarketCalendar) -> None:
    r = build_research(clock.now, date(2026, 9, 30), _svc(clock), _cfg(),
                       FakeBatchPrices(calendar), {})  # fmt: skip
    assert {c["day"] for c in r["companies"]} == {"2026-09-30"}


def test_validation_catches_broken_files() -> None:
    assert validate_research({"schema": 9})
    assert validate_research({"schema": 1, "companies": []})
    bad = {"schema": 1, "companies": [{"s": "AAPL", "v": "buy", "close": 1.0},
                                      {"s": "MSFT", "v": "fit", "close": 0},
                                      {"s": "<script>", "v": "fit"}]}  # fmt: skip
    errs = validate_research(bad)
    assert len(errs) == 3


def test_write_keeps_the_last_good_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    good = {"schema": 1, "generated_at": "2026-10-01T22:00:00+00:00",
            "companies": [{"s": "AAPL", "v": "fit", "close": 200.0}]}  # fmt: skip
    import keystone_ledger.tools.research as mod

    monkeypatch.setattr(mod, "_load_previous", lambda url: good if url else None)
    out = tmp_path / "research.json"
    st = write_research({"schema": 1, "companies": []}, [], out, "https://x/research.json")
    assert not st["ok"] and st["kept_previous"]
    assert json.loads(out.read_text())["generated_at"] == good["generated_at"]
    st = write_research(None, ["research: SEC data unavailable today"], tmp_path / "r2.json", None)
    assert not st["ok"] and not st["kept_previous"] and not (tmp_path / "r2.json").exists()
    st = write_research(good, [], out, None)
    assert st["ok"] and st["companies"] == 1


def test_parse_batch_reads_yahoo_frames_and_drops_bad_rows() -> None:
    idx = pd.to_datetime(["2026-09-30", "2026-10-01", "2026-10-02"])
    cols = pd.MultiIndex.from_product([["AAPL", "BRK-B"], ["Close", "Dividends", "Stock Splits"]])
    raw = pd.DataFrame(
        [[200.0, 0.0, 0.0, 450.0, 0.0, 0.0],
         [float("nan"), 0.25, 0.0, 451.0, 0.0, 0.0],
         [202.0, 0.0, 4.0, -1.0, 0.0, 0.0]],
        index=idx, columns=cols,
    )  # fmt: skip
    out = parse_batch(raw, {"AAPL": "AAPL", "BRK-B": "BRK.B", "MISSING": "MISSING"})
    assert list(out["AAPL"].closes) == [200.0, 202.0]  # the NaN row is dropped, not filled
    assert out["AAPL"].dividends == {date(2026, 10, 1): 0.25}
    assert out["AAPL"].splits == {date(2026, 10, 2): 4.0}
    assert list(out["BRK.B"].closes) == [450.0, 451.0]  # a negative price is dropped
    assert "MISSING" not in out


def test_fetch_batch_validates_and_wraps_errors() -> None:
    def boom(*a: Any, **k: Any) -> pd.DataFrame:
        raise ConnectionError("https://secret.example/?cookie=1")

    p = YFinanceProvider(MinIntervalLimiter(1000.0), download=boom)
    with pytest.raises(ProviderError) as e:
        p.fetch_batch(["AAPL"], date(2026, 1, 1), date(2026, 10, 2))
    assert "secret" not in str(e.value) and "ConnectionError" in str(e.value)
    with pytest.raises(ValueError, match="interval"):
        p.fetch_batch(["AAPL"], date(2026, 1, 1), date(2026, 10, 2), interval="1m")
    with pytest.raises(ValueError, match="symbol"):
        p.fetch_batch(["../etc"], date(2026, 1, 1), date(2026, 10, 2))

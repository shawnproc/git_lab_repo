from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from keystone_ledger.api.deps import AppState
from keystone_ledger.app import build_state, create_app
from keystone_ledger.config import AppConfig
from keystone_ledger.core.auth import ensure_setup_token
from keystone_ledger.data.base import BAR_COLUMNS, ProviderError
from keystone_ledger.data.calendar import MarketCalendar
from keystone_ledger.data.fundamentals import FundamentalsService
from keystone_ledger.data.sec_provider import FrameValue, TickerInfo
from keystone_ledger.data.service import MarketDataService
from keystone_ledger.settings import Settings

BASE_URL = "http://127.0.0.1:8787"
ORIGIN = "http://127.0.0.1:8787"
PASSWORD = "correct horse battery staple"


class FakeClock:
    def __init__(self, now: datetime) -> None:
        self.now = now

    def __call__(self) -> datetime:
        return self.now

    def advance(self, **kw: float) -> None:
        self.now += timedelta(**kw)


def make_bars(days: list[date], start_price: float = 100.0, seed: int = 0) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    close = start_price * np.cumprod(1 + rng.normal(0, 0.01, len(days)))
    df = pd.DataFrame(
        {
            "open": close * 0.998,
            "high": close * 1.01,
            "low": close * 0.99,
            "close": close,
            "adj_close": close * 0.98,
            "volume": rng.integers(1_000_000, 5_000_000, len(days)).astype(float),
        },
        index=pd.Index(days, name="day"),
    )
    return df[list(BAR_COLUMNS)]


@dataclass
class FakePriceProvider:
    calendar: MarketCalendar
    name: str = "fake_prices"
    calls: list[tuple[str, date, date]] = field(default_factory=list)
    fail: ProviderError | None = None
    # Latest day the "provider" has published (simulates publication lag).
    available_through: date | None = None
    adj_factor: float = 0.98

    def fetch_daily_bars(self, symbol: str, start: date, end: date) -> pd.DataFrame:
        self.calls.append((symbol, start, end))
        if self.fail:
            raise self.fail
        last = min(end, self.available_through) if self.available_through else end
        days = self.calendar.sessions_between(date(2010, 1, 4), last)
        full = make_bars(days, seed=len(symbol))
        full["adj_close"] = full["close"] * self.adj_factor
        out: pd.DataFrame = full.loc[[d for d in full.index if d >= start]]
        return out


@dataclass
class FakeMacroProvider:
    calendar: MarketCalendar
    name: str = "fake_macro"
    calls: list[tuple[str, date, date]] = field(default_factory=list)
    fail: ProviderError | None = None
    lag_sessions: int = 1

    def fetch_series(self, series_id: str, start: date, end: date) -> pd.Series:
        self.calls.append((series_id, start, end))
        if self.fail:
            raise self.fail
        days = self.calendar.sessions_between(start, end)
        days = days[: len(days) - self.lag_sessions] if self.lag_sessions else days
        return pd.Series([15.0 + (i % 7) for i in range(len(days))], index=days, dtype=float)


# Synthetic company financials (USD): revenue at `rev0` in 2021 growing `g`/yr, operating margin
# `m` (+`dm` per year), FCF = `fcf` x revenue, debt = `debt` x operating income.
COMPANIES: dict[str, dict[str, float]] = {
    "AAPL": {"cik": 320193, "rev0": 300e9, "g": 0.08, "m": 0.28, "dm": 0.01, "fcf": 0.25, "debt": 0.9},
    "MSFT": {"cik": 789019, "rev0": 160e9, "g": 0.14, "m": 0.40, "dm": 0.01, "fcf": 0.30, "debt": 0.4},
    "NVDA": {"cik": 1045810, "rev0": 25e9, "g": 0.60, "m": 0.35, "dm": 0.05, "fcf": 0.40, "debt": 0.2},
    "ORCL": {"cik": 1341439, "rev0": 40e9, "g": 0.07, "m": 0.30, "dm": 0.0, "fcf": 0.20, "debt": 6.0},
    "KO": {"cik": 21344, "rev0": 38e9, "g": 0.06, "m": 0.29, "dm": 0.0, "fcf": 0.25, "debt": 2.5},
    "NKE": {"cik": 320187, "rev0": 46e9, "g": 0.01, "m": 0.13, "dm": -0.01, "fcf": 0.10, "debt": 1.2},
    "XOM": {"cik": 34088, "rev0": 280e9, "g": 0.04, "m": 0.15, "dm": 0.0, "fcf": 0.08, "debt": 1.0},
    "LLY": {"cik": 59478, "rev0": 28e9, "g": 0.18, "m": 0.30, "dm": 0.01, "fcf": 0.15, "debt": 1.5},
    "OTHER": {"cik": 999999, "rev0": 1e9, "g": 0.5, "m": 0.5, "dm": 0.0, "fcf": 0.5, "debt": 0.1},
}  # fmt: skip


def company_values(name: str, year: int) -> dict[str, float]:
    c = COMPANIES[name]
    rev = c["rev0"] * (1 + c["g"]) ** (year - 2021)
    oi = rev * (c["m"] + c["dm"] * (year - 2021))
    cfo = rev * c["fcf"] * 1.2
    capex = cfo - rev * c["fcf"]
    return {"rev": rev, "oi": oi, "cfo": cfo, "capex": capex, "debt": oi * c["debt"]}


@dataclass
class FakeFundamentalsProvider:
    name: str = "fake_sec"
    calls: int = 0
    fail: ProviderError | None = None
    first_year: int = 2021

    def fetch_tickers(self) -> dict[str, TickerInfo]:
        self.calls += 1
        if self.fail:
            raise self.fail
        return {t: TickerInfo(int(c["cik"]), f"{t} Corp") for t, c in COMPANIES.items()}

    def fetch_frame(self, tag: str, period: str) -> dict[int, FrameValue]:
        self.calls += 1
        if self.fail:
            raise self.fail
        year = int(period[2:6])
        if year < self.first_year:
            return {}
        out: dict[int, FrameValue] = {}
        for t, c in COMPANIES.items():
            v = company_values(t, year)
            # MSFT reported revenue under the older tag, to exercise tag fallback.
            rev_tag = (
                "Revenues"
                if t == "MSFT"
                else ("RevenueFromContractWithCustomerExcludingAssessedTax")
            )
            key = {
                rev_tag: "rev",
                "OperatingIncomeLoss": "oi",
                "NetCashProvidedByUsedInOperatingActivities": "cfo",
                "PaymentsToAcquirePropertyPlantAndEquipment": "capex",
                "LongTermDebt": "debt",
            }.get(tag)
            if key is None:
                continue
            out[int(c["cik"])] = FrameValue(v[key], date(year, 12, 31), f"acc-{t}-{year}")
        return out


@pytest.fixture
def calendar() -> MarketCalendar:
    return MarketCalendar()


@pytest.fixture
def clock() -> FakeClock:
    # Friday 2026-10-02, 17:00 ET (after the close).
    return FakeClock(datetime(2026, 10, 2, 21, 0, tzinfo=UTC))


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(_env_file=None, data_dir=tmp_path, config_path=tmp_path / "none.toml")


@pytest.fixture
def prices(calendar: MarketCalendar) -> FakePriceProvider:
    return FakePriceProvider(calendar)


@pytest.fixture
def macro(calendar: MarketCalendar) -> FakeMacroProvider:
    return FakeMacroProvider(calendar)


@pytest.fixture
def sec() -> FakeFundamentalsProvider:
    return FakeFundamentalsProvider()


@pytest.fixture
def state(
    settings: Settings,
    clock: FakeClock,
    calendar: MarketCalendar,
    prices: FakePriceProvider,
    macro: FakeMacroProvider,
    sec: FakeFundamentalsProvider,
) -> AppState:
    return build_state(
        settings,
        AppConfig(),
        in_memory=True,
        clock=clock,
        market_factory=lambda sf: MarketDataService(
            sf, prices, macro, calendar, history_years=3, clock=clock
        ),
        fundamentals_factory=lambda sf: FundamentalsService(
            sf, sec, max_age=timedelta(days=30), clock=clock
        ),
    )


@pytest.fixture
def market(state: AppState) -> MarketDataService:
    return state.market


@pytest.fixture
def client(state: AppState) -> Iterator[TestClient]:
    app = create_app(state, frontend_dist=None)
    with TestClient(app, base_url=BASE_URL) as c:
        c.headers.update({"origin": ORIGIN})
        yield c


@pytest.fixture
def setup_token(settings: Settings) -> str:
    return ensure_setup_token(settings.setup_token_path)


@pytest.fixture
def authed(client: TestClient, setup_token: str) -> TestClient:
    r = client.post(
        "/api/auth/setup",
        json={"setup_token": setup_token, "username": "shawn", "password": PASSWORD},
    )
    assert r.status_code == 201, r.text
    client.headers.update({"x-csrf-token": r.json()["csrf_token"]})
    return client

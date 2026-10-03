from __future__ import annotations

from datetime import date
from typing import Any

import httpx
import numpy as np
import pandas as pd
import pytest

from keystone_ledger.core.logging import redact
from keystone_ledger.data.base import (
    ProviderError,
    RateLimitedError,
    SymbolNotFoundError,
    validate_bars,
    validate_symbol,
)
from keystone_ledger.data.calendar import MarketCalendar
from keystone_ledger.data.fred_provider import FredCsvProvider, parse_fred_csv
from keystone_ledger.data.ratelimit import MinIntervalLimiter
from keystone_ledger.data.yfinance_provider import YFinanceProvider, to_yahoo_symbol

from .conftest import make_bars


class NoWait(MinIntervalLimiter):
    def __init__(self) -> None:
        super().__init__(1000)

    def wait(self) -> None:
        return None


# --- validation -------------------------------------------------------------------------------


@pytest.mark.parametrize("sym", ["SPY", "BRK.B", "BF-B", "^VIX", "^GSPC", "msft"])
def test_valid_symbols(sym: str) -> None:
    assert validate_symbol(sym) == sym.upper()


@pytest.mark.parametrize("sym", ["", "SPY;", "A B", "../x", "AAAAAAAAAAAA", "SPY.ABCDE", "$SPY"])
def test_invalid_symbols(sym: str) -> None:
    with pytest.raises(ValueError, match="invalid symbol"):
        validate_symbol(sym)


def test_validate_bars_drops_but_never_repairs() -> None:
    days = [date(2026, 9, d) for d in (1, 2, 3, 4, 8, 9)]
    df = make_bars(days)
    original = df.copy()
    df.loc[days[1], "close"] = np.nan
    df.loc[days[2], "low"] = -1
    df.loc[days[3], "high"] = float(df["low"].iloc[3]) * 0.5
    out, rep = validate_bars(df)
    assert list(out.index) == [days[0], days[4], days[5]]
    assert rep.dropped == {"non_finite": 1, "non_positive": 1, "high_below_body": 1}
    pd.testing.assert_frame_equal(out, original.loc[out.index])


def test_validate_bars_missing_column() -> None:
    with pytest.raises(ProviderError):
        validate_bars(pd.DataFrame({"open": [1.0]}))


# --- yfinance ---------------------------------------------------------------------------------


class FakeTicker:
    def __init__(self, symbol: str, behavior: Any) -> None:
        self.symbol = symbol
        self.behavior = behavior

    def history(self, **kw: Any) -> pd.DataFrame:
        self.behavior.kwargs = kw
        self.behavior.symbol = self.symbol
        if isinstance(self.behavior.result, Exception):
            raise self.behavior.result
        out: pd.DataFrame = self.behavior.result
        return out


class Behavior:
    result: Any = None
    kwargs: dict[str, Any]
    symbol: str


def _yf_frame() -> pd.DataFrame:
    idx = pd.DatetimeIndex(
        ["2026-09-30", "2026-10-01", "2026-10-02"], tz="America/New_York", name="Date"
    )
    return pd.DataFrame(
        {
            "Open": [1.0, 2.0, 3.0],
            "High": [1.5, 2.5, 3.5],
            "Low": [0.5, 1.5, 2.5],
            "Close": [1.2, 2.2, 3.2],
            "Adj Close": [1.1, 2.1, 3.1],
            "Volume": [10, 20, 30],
        },
        index=idx,
    )


def test_yfinance_normalizes_and_passes_safe_options() -> None:
    b = Behavior()
    b.result = _yf_frame()
    p = YFinanceProvider(NoWait(), ticker_factory=lambda s: FakeTicker(s, b))
    df = p.fetch_daily_bars("BRK.B", date(2026, 9, 30), date(2026, 10, 2))
    assert b.symbol == "BRK-B"
    assert b.kwargs["end"] == "2026-10-03"  # exclusive end
    assert b.kwargs["repair"] is False  # never let the library rewrite prices
    assert b.kwargs["auto_adjust"] is False
    assert list(df.index) == [date(2026, 9, 30), date(2026, 10, 1), date(2026, 10, 2)]
    assert list(df.columns) == ["open", "high", "low", "close", "adj_close", "volume"]


def test_yfinance_reports_splits_from_the_same_request() -> None:
    b = Behavior()
    frame = _yf_frame()
    frame["Dividends"] = [0.0, 0.0, 0.0]
    frame["Stock Splits"] = [0.0, 10.0, 0.0]
    b.result = frame
    p = YFinanceProvider(NoWait(), ticker_factory=lambda s: FakeTicker(s, b))
    bars, splits = p.fetch_history("NVDA", date(2026, 9, 30), date(2026, 10, 2))
    assert splits == {date(2026, 10, 1): 10.0}
    assert list(bars.columns) == ["open", "high", "low", "close", "adj_close", "volume"]
    assert b.kwargs["actions"] is True


def test_yfinance_error_mapping() -> None:
    from yfinance import exceptions as yfe

    b = Behavior()
    p = YFinanceProvider(NoWait(), ticker_factory=lambda s: FakeTicker(s, b))
    b.result = yfe.YFRateLimitError()
    with pytest.raises(RateLimitedError):
        p.fetch_daily_bars("SPY", date(2026, 1, 1), date(2026, 1, 5))
    b.result = RuntimeError("https://query1.finance.yahoo.com/?crumb=SECRET")
    with pytest.raises(ProviderError) as ei:
        p.fetch_daily_bars("SPY", date(2026, 1, 1), date(2026, 1, 5))
    assert "SECRET" not in str(ei.value)
    b.result = yfe.YFTzMissingError("ZZZZ")
    with pytest.raises(SymbolNotFoundError):
        p.fetch_daily_bars("ZZZZ", date(2026, 1, 1), date(2026, 1, 5))


def test_to_yahoo_symbol() -> None:
    assert to_yahoo_symbol("BRK.B") == "BRK-B"
    assert to_yahoo_symbol("^VIX") == "^VIX"


# --- FRED -------------------------------------------------------------------------------------

FRED_CSV = "observation_date,VIXCLS\n2026-09-29,16.1\n2026-09-30,.\n2026-10-01,17.25\n"


def test_parse_fred_csv_drops_missing() -> None:
    s = parse_fred_csv(FRED_CSV, "VIXCLS")
    assert dict(s) == {date(2026, 9, 29): 16.1, date(2026, 10, 1): 17.25}


def test_parse_fred_csv_rejects_layout() -> None:
    with pytest.raises(ProviderError):
        parse_fred_csv("a,b,c\n1,2,3\n", "VIXCLS")


def _fred_client(handler: Any) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_fred_provider_request_and_errors() -> None:
    seen: dict[str, Any] = {}

    def ok(req: httpx.Request) -> httpx.Response:
        seen["url"] = req.url
        return httpx.Response(200, text=FRED_CSV, headers={"content-type": "text/csv"})

    p = FredCsvProvider(NoWait(), client=_fred_client(ok))
    s = p.fetch_series("vixcls", date(2026, 9, 1), date(2026, 10, 2))
    assert len(s) == 2
    assert seen["url"].params["id"] == "VIXCLS"
    assert seen["url"].params["cosd"] == "2026-09-01"

    p429 = FredCsvProvider(NoWait(), client=_fred_client(lambda r: httpx.Response(429)))
    with pytest.raises(RateLimitedError):
        p429.fetch_series("VIXCLS", date(2026, 9, 1), date(2026, 10, 2))

    html = FredCsvProvider(
        NoWait(),
        client=_fred_client(
            lambda r: httpx.Response(200, text="<html>", headers={"content-type": "text/html"})
        ),
    )
    with pytest.raises(ProviderError, match="not CSV"):
        html.fetch_series("VIXCLS", date(2026, 9, 1), date(2026, 10, 2))

    with pytest.raises(ValueError, match="invalid series"):
        p.fetch_series("VIX&evil=1", date(2026, 9, 1), date(2026, 10, 2))


# --- rate limiter -----------------------------------------------------------------------------


def test_min_interval_limiter() -> None:
    t = [0.0]
    sleeps: list[float] = []

    def sleep(d: float) -> None:
        sleeps.append(d)
        t[0] += d

    lim = MinIntervalLimiter(2.0, clock=lambda: t[0], sleep=sleep)
    lim.wait()
    lim.wait()
    lim.wait()
    assert sleeps == [0.5, 0.5]


# --- calendar ---------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("now", "expected"),
    [
        ("2026-10-02T15:00:00+00:00", date(2026, 10, 1)),  # Fri 11:00 ET, before close
        ("2026-10-02T20:30:00+00:00", date(2026, 10, 2)),  # Fri after close
        ("2026-10-04T12:00:00+00:00", date(2026, 10, 2)),  # Sunday
        ("2026-11-26T20:00:00+00:00", date(2026, 11, 25)),  # Thanksgiving
        ("2026-11-27T18:30:00+00:00", date(2026, 11, 27)),  # after 1pm ET early close
        ("2026-11-27T17:30:00+00:00", date(2026, 11, 25)),  # before early close
    ],
)
def test_last_completed_session(now: str, expected: date) -> None:
    from datetime import datetime

    assert MarketCalendar().last_completed_session(datetime.fromisoformat(now)) == expected


def test_calendar_helpers() -> None:
    c = MarketCalendar()
    assert not c.is_session(date(2026, 12, 25))
    assert c.previous_session(date(2026, 10, 5)) == date(2026, 10, 2)
    assert c.add_sessions(date(2026, 10, 2), 3) == date(2026, 10, 7)
    assert len(c.sessions_between(date(2026, 9, 28), date(2026, 10, 2))) == 5


# --- logging ----------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "text",
    [
        "cookie: kl_session=abc123def; path=/",
        "apikey=supersecret&s=spy",
        '{"password": "hunter2hunter2"}',
        "X-CSRF-Token: tok123",
        "Authorization: Bearer zzz",
        "setup_token=abcdef",
    ],
)
def test_redaction(text: str) -> None:
    out = redact(text)
    assert "[REDACTED]" in out
    for secret in ("abc123def", "supersecret", "hunter2hunter2", "tok123", "zzz", "abcdef"):
        assert secret not in out

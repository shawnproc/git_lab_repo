from __future__ import annotations

from datetime import date
from typing import Any

import httpx
import pytest

from keystone_ledger.data.base import ProviderError, RateLimitedError
from keystone_ledger.data.fundamentals import FundamentalsService
from keystone_ledger.data.sec_provider import SecEdgarProvider, parse_frame, parse_tickers

from .conftest import FakeClock, FakeFundamentalsProvider
from .test_data import NoWait

UA = "Rashawn Proctor test@example.com"


def _provider(handler: Any, ua: str = UA) -> SecEdgarProvider:
    return SecEdgarProvider(
        ua, NoWait(), client=httpx.Client(transport=httpx.MockTransport(handler))
    )


def test_parse_tickers() -> None:
    out = parse_tickers({
        "0": {"cik_str": 320193, "ticker": "AAPL", "title": "Apple Inc."},
        "1": {"cik_str": "bad", "ticker": "X", "title": "x"},
        "2": {"ticker": "NOCIK"},
    })  # fmt: skip
    assert out["AAPL"].cik == 320193
    assert set(out) == {"AAPL"}
    with pytest.raises(ProviderError):
        parse_tickers([])


def test_parse_frame_drops_bad_rows() -> None:
    out = parse_frame({
        "data": [
            {"cik": 1, "end": "2024-12-31", "val": 5.0, "accn": "a"},
            {"cik": 2, "end": "not-a-date", "val": 1.0},
            {"cik": 3, "end": "2024-12-31", "val": "NaN"},
            {"cik": 4, "end": "2024-12-31"},
        ]
    })  # fmt: skip
    assert set(out) == {1}
    assert out[1].end == date(2024, 12, 31)


def test_provider_sends_user_agent_and_handles_statuses() -> None:
    seen: dict[str, Any] = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["ua"] = req.headers["user-agent"]
        seen["url"] = str(req.url)
        if "Missing" in req.url.path:
            return httpx.Response(404)
        if "Blocked" in req.url.path:
            return httpx.Response(403)
        return httpx.Response(200, json={"data": [{"cik": 7, "end": "2024-12-31", "val": 1}]})

    p = _provider(handler)
    assert p.fetch_frame("Revenues", "CY2024")[7].value == 1.0
    assert seen["ua"] == UA
    assert seen["url"] == "https://data.sec.gov/api/xbrl/frames/us-gaap/Revenues/USD/CY2024.json"
    assert p.fetch_frame("Missing", "CY2024Q4I") == {}
    with pytest.raises(RateLimitedError):
        p.fetch_frame("Blocked", "CY2024")


@pytest.mark.parametrize(("tag", "period"), [("Rev/../x", "CY2024"), ("Revenues", "2024"),
                                             ("Revenues", "CY2024&x=1")])  # fmt: skip
def test_provider_validates_inputs(tag: str, period: str) -> None:
    p = _provider(lambda r: httpx.Response(200, json={"data": []}))
    with pytest.raises(ValueError, match="invalid"):
        p.fetch_frame(tag, period)


def test_provider_requires_contact_user_agent() -> None:
    p = _provider(lambda r: httpx.Response(200, json={}), ua="")
    with pytest.raises(ProviderError, match="KL_SEC_USER_AGENT"):
        p.fetch_frame("Revenues", "CY2024")


def test_refresh_keeps_only_candidates_and_respects_max_age(
    state: Any, sec: FakeFundamentalsProvider, clock: FakeClock
) -> None:
    svc: FundamentalsService = state.fundamentals
    svc.refresh(["AAPL", "MSFT"])
    facts = svc.facts(["AAPL", "MSFT", "OTHER"])
    assert set(facts) == {"AAPL", "MSFT", "OTHER"}  # OTHER has a CIK...
    assert facts["OTHER"] == {}  # ...but its facts weren't stored
    assert ("Revenues", "CY2025") in facts["MSFT"]
    assert not svc.status().stale
    calls = sec.calls
    svc.refresh(["AAPL", "MSFT"])
    assert sec.calls == calls  # fresh: no requests
    clock.advance(days=31)
    assert svc.status().stale
    svc.refresh(["AAPL", "MSFT"])
    assert sec.calls > calls


def test_refresh_failure_keeps_old_data(state: Any, sec: FakeFundamentalsProvider,
                                        clock: FakeClock) -> None:  # fmt: skip
    svc: FundamentalsService = state.fundamentals
    svc.refresh(["AAPL"])
    clock.advance(days=31)
    sec.fail = RateLimitedError("sec: HTTP 429")
    svc.refresh(["AAPL"])
    st = svc.status()
    assert st.stale and st.last_error == "sec: HTTP 429"
    assert svc.facts(["AAPL"])["AAPL"]  # previous facts untouched

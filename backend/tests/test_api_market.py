from __future__ import annotations

from fastapi.testclient import TestClient

from keystone_ledger.data.base import ProviderError

from .conftest import FakePriceProvider


def test_status_before_refresh_is_loudly_stale(authed: TestClient) -> None:
    body = authed.get("/api/market/status").json()
    assert body["any_stale"] is True
    assert body["benchmark_close"] is None
    assert body["benchmark_freshness"]["reason"] == "no data cached"


def test_refresh_then_status(authed: TestClient, prices: FakePriceProvider) -> None:
    body = authed.post("/api/market/refresh").json()
    assert body["benchmark"] == "SPY"
    assert body["benchmark_day"] == "2026-10-02"
    assert body["benchmark_freshness"]["stale"] is False
    assert body["benchmark_freshness"]["source"] == "fake_prices"
    assert body["benchmark_freshness"]["fetched_at"]
    assert body["vix"] is not None
    # FRED-style one-session lag is tolerated for macro series.
    assert body["vix_freshness"]["stale"] is False
    assert body["any_stale"] is False
    assert len(prices.calls) == 1


def test_bars_endpoint(authed: TestClient) -> None:
    authed.post("/api/market/refresh")
    r = authed.get("/api/market/bars/SPY", params={"days": 30})
    body = r.json()
    assert r.status_code == 200
    assert 15 <= len(body["bars"]) <= 23
    assert set(body["bars"][0]) == {"day", "open", "high", "low", "close", "adj_close", "volume"}


def test_bad_symbol_rejected(authed: TestClient) -> None:
    for sym in ("SPY;DROP", "../etc", "a" * 20, "SP Y"):
        assert authed.get(f"/api/market/bars/{sym}").status_code in (404, 422), sym


def test_provider_failure_surfaces(authed: TestClient, prices: FakePriceProvider) -> None:
    prices.fail = ProviderError("fake: boom")
    body = authed.post("/api/market/refresh").json()
    f = body["benchmark_freshness"]
    assert f["stale"] is True
    assert f["last_error"] == "fake: boom"


def test_config_endpoint(authed: TestClient) -> None:
    body = authed.get("/api/config").json()
    assert body["config"]["swing"]["risk_per_trade_pct"] == 1.0
    assert len(body["history"]) == 1


def test_config_has_no_write_endpoint(authed: TestClient) -> None:
    for method in ("post", "put", "patch"):
        r = getattr(authed, method)("/api/config", json={"swing": {"risk_per_trade_pct": 5}})
        assert r.status_code == 405

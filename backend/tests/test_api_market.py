from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from keystone_ledger.data.base import ProviderError

from .conftest import FakePriceProvider


def test_bars_endpoint(authed: TestClient, state: Any) -> None:
    state.market.refresh_bars("SPY")
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
    f = body["index_freshness"]
    assert f["stale"] is True
    assert f["last_error"] == "fake: boom"
    assert body["any_stale"] is True


def test_config_endpoint(authed: TestClient) -> None:
    body = authed.get("/api/config").json()
    assert body["config"]["plan"]["core_pct"] == 60.0
    assert len(body["history"]) == 1


def test_config_has_no_write_endpoint(authed: TestClient) -> None:
    for method in ("post", "put", "patch"):
        r = getattr(authed, method)("/api/config", json={"plan": {"max_stocks": 10}})
        assert r.status_code == 405

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from keystone_ledger.api.deps import AppState
from keystone_ledger.data.research_feed import ResearchFeed

from .conftest import FakeClock

RESEARCH: dict[str, Any] = {
    "schema": 1,
    "generated_at": "2026-10-02T22:40:00+00:00",
    "source": "SEC EDGAR frames + yfinance",
    "min_revenue_usd": 1e9,
    "companies": [
        {"s": "AAPL", "n": "Apple Inc.", "v": "fit", "h": "ok", "close": 255.5, "chg": 1.2,
         "day": "2026-10-02", "dy": 0.4},
        {"s": "ORCL", "n": "Oracle", "v": "no", "h": "debt", "close": 180.0},
        {"s": "NVDA", "n": "NVIDIA", "v": "pricey", "h": "pricey", "close": 180.0},
    ],
}  # fmt: skip


def _serve(state: AppState, body: Any, status: int = 200) -> list[str]:
    calls: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        calls.append(str(req.url))
        return httpx.Response(status, content=json.dumps(body).encode())

    state.research._client = httpx.Client(transport=httpx.MockTransport(handler))
    return calls


def test_research_needs_auth_and_csrf(client: TestClient, authed: TestClient) -> None:
    del authed.headers["x-csrf-token"]
    assert authed.post("/api/research/refresh").status_code == 403
    assert authed.put("/api/watchlist/AAPL", json={}).status_code == 403
    assert authed.patch("/api/watchlist/AAPL", json={"include": True}).status_code == 403
    assert authed.delete("/api/watchlist/AAPL").status_code == 403


def test_get_never_downloads_and_says_it_is_missing(authed: TestClient, state: AppState) -> None:
    calls = _serve(state, RESEARCH)
    body = authed.get("/api/research").json()
    assert body["data"] is None and body["status"]["stale"] is True
    assert calls == []


def test_refresh_downloads_validates_and_caches(authed: TestClient, state: AppState) -> None:
    calls = _serve(state, RESEARCH)
    body = authed.post("/api/research/refresh").json()
    assert body["status"]["stale"] is False and len(body["data"]["companies"]) == 3
    authed.post("/api/research/refresh")  # fresh copy: no second download
    assert len(calls) == 1 and calls[0].startswith("https://")


def test_a_broken_file_keeps_the_last_good_copy(authed: TestClient, state: AppState,
                                               clock: FakeClock) -> None:  # fmt: skip
    _serve(state, RESEARCH)
    authed.post("/api/research/refresh")
    clock.advance(hours=7)
    _serve(state, {"schema": 1, "companies": [{"s": "AAPL", "v": "buy now"}]})
    body = authed.post("/api/research/refresh").json()
    assert body["data"]["companies"][0]["v"] == "fit"  # the last good one
    assert body["status"]["stale"] is True and "unknown verdict" in body["status"]["last_error"]


def test_watchlist_uses_search_data_not_the_request(authed: TestClient, state: AppState) -> None:
    _serve(state, RESEARCH)
    assert authed.put("/api/watchlist/AAPL", json={}).status_code == 404  # no data yet
    authed.post("/api/research/refresh")
    assert authed.put("/api/watchlist/AAPL", json={"added_price": 1}).status_code == 422
    items = authed.put("/api/watchlist/AAPL", json={}).json()
    assert items[0]["added_price"] == 255.5 and items[0]["verdict_at_add"] == "fit"
    assert items[0]["include"] is False
    assert authed.put("/api/watchlist/ZZZZ", json={}).status_code == 404
    assert authed.put("/api/watchlist/..%2Fx", json={}).status_code in (404, 422)


def test_include_adds_a_good_fit_to_the_plan_under_the_cap(
    authed: TestClient, state: AppState
) -> None:
    _serve(state, RESEARCH)
    authed.post("/api/research/refresh")
    authed.post("/api/plan/refresh")
    for sym in ("AAPL", "ORCL", "NVDA"):
        authed.put(f"/api/watchlist/{sym}", json={})
    assert authed.patch("/api/watchlist/ORCL", json={"include": True}).status_code == 409
    assert authed.patch("/api/watchlist/NVDA", json={"include": True}).status_code == 409
    assert authed.patch("/api/watchlist/AAPL", json={"include": True}).status_code == 200
    targets = {t["symbol"]: t for t in authed.get("/api/plan").json()["targets"]}
    assert (
        targets["AAPL"]["target_pct"] == 8.0 and targets["AAPL"]["name"] == "AAPL Corp"
    )  # SEC name first
    assert "Search" in targets["AAPL"]["why"]
    assert max(t["target_pct"] for t in targets.values() if t["kind"] == "stock") <= 8.0
    assert sum(t["target_pct"] for t in targets.values()) == pytest.approx(100)
    assert targets["VTI"]["target_pct"] == pytest.approx(45.0)  # 5 stocks x 8% = 40%
    assert authed.delete("/api/watchlist/AAPL").status_code == 204
    assert "AAPL" not in {t["symbol"] for t in authed.get("/api/plan").json()["targets"]}


def test_cache_file_round_trip_and_rejects_tampering(tmp_path: Path) -> None:
    clock = FakeClock(datetime(2026, 10, 5, 15, 0, tzinfo=UTC))
    path = tmp_path / "research-cache.json"

    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=json.dumps(RESEARCH).encode())

    feed = ResearchFeed("https://x.test/research.json", path, clock,
                        httpx.Client(transport=httpx.MockTransport(handler)))  # fmt: skip
    feed.refresh()
    again = ResearchFeed("https://x.test/research.json", path, clock)
    assert again.data() is not None and again.company("AAPL") is not None
    raw = json.loads(path.read_text())
    raw["data"]["companies"][0]["close"] = -1
    path.write_text(json.dumps(raw))
    assert ResearchFeed("https://x.test/research.json", path, clock).data() is None

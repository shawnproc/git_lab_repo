from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient


def _refresh_all(c: TestClient) -> None:
    assert c.post("/api/plan/refresh").status_code == 200
    assert c.post("/api/market/refresh").status_code == 200


def test_endpoints_require_auth(client: TestClient) -> None:
    for path in ("/api/dashboard", "/api/plan", "/api/holdings", "/api/chart/VTI", "/api/learn"):
        assert client.get(path).status_code == 401, path


def test_state_changes_require_csrf(authed: TestClient) -> None:
    del authed.headers["x-csrf-token"]
    assert authed.post("/api/plan/refresh").status_code == 403
    assert authed.post("/api/market/refresh").status_code == 403
    assert authed.put("/api/holdings", json={"holdings": []}).status_code == 403
    assert authed.post("/api/contribution", json={"amount": 100}).status_code == 403


def test_dashboard_before_any_data_is_unknown_and_stale(authed: TestClient) -> None:
    body = authed.get("/api/dashboard").json()
    assert body["mood"]["mood"] == "unknown"
    assert body["any_stale"] is True
    assert body["portfolio"]["value"] == 0


def test_plan_after_refresh(authed: TestClient) -> None:
    body = authed.post("/api/plan/refresh").json()
    targets = {t["symbol"]: t for t in body["targets"]}
    assert set(targets) == {"VTI", "VXUS", "NVDA", "MSFT", "LLY", "KO"}
    assert targets["NVDA"]["target_pct"] == 8.0
    assert targets["VTI"]["target_pct"] == pytest.approx(51.0)
    assert sum(t["target_pct"] for t in body["targets"]) == pytest.approx(100)
    assert body["basis_is_reference"] is True
    assert targets["VTI"]["target_value"] == pytest.approx(5100.0)
    assert targets["VTI"]["name"] == "Vanguard Morningstar Total Stock Market ETF"
    assert targets["MSFT"]["name"] == "MSFT Corp"
    assert "official SEC reports" in targets["MSFT"]["why"]
    assert "Morningstar US Total Market Index" in targets["VTI"]["why"]
    assert body["fundamentals"]["stale"] is False
    screened = {r["symbol"]: r for r in body["screen"]}
    assert len(screened) == 40
    assert screened["AAPL"]["qualifies"] and not screened["AAPL"]["picked"]
    assert [c["status"] for c in screened["NKE"]["checks"]].count("fail") >= 1
    assert screened["COST"]["note"] == "no SEC filer found for this ticker"


def test_dashboard_mood_and_portfolio(authed: TestClient) -> None:
    _refresh_all(authed)
    authed.put(
        "/api/holdings",
        json={"holdings": [{"symbol": "VTI", "shares": 10, "avg_cost": 50.0}]},
    )
    body = authed.get("/api/dashboard").json()
    assert body["mood"]["mood"] in ("green", "yellow", "red")
    assert len(body["mood"]["reasons"]) == 2
    p = body["portfolio"]
    assert p["value"] > 0
    assert p["total_change"] == pytest.approx(p["value"] - 500)
    assert p["day_change_pct"] is not None
    assert body["holdings_freshness"]["VTI"]["source"] == "fake_prices"


def test_holdings_drift_and_validation(authed: TestClient) -> None:
    _refresh_all(authed)
    r = authed.put(
        "/api/holdings",
        json={
            "holdings": [
                {"symbol": "vti", "shares": 10, "avg_cost": 100},
                {"symbol": "GME", "shares": 1, "avg_cost": 20},
            ]
        },
    )
    assert r.status_code == 200, r.text
    rows = {d["symbol"]: d for d in r.json()["drift"]}
    assert rows["GME"]["kind"] == "off_plan" and rows["GME"]["flagged"]
    assert rows["VTI"]["flagged"]  # ~all of the portfolio vs a 51% target
    assert rows["NVDA"]["actual_pct"] == 0
    bad: list[dict[str, Any]] = [
        {"holdings": [{"symbol": "VTI", "shares": -1, "avg_cost": 1}]},
        {"holdings": [{"symbol": "VT I", "shares": 1, "avg_cost": 1}]},
        {"holdings": [{"symbol": "VTI", "shares": 1, "avg_cost": 1}] * 2},
        {"holdings": [{"symbol": f"A{i}", "shares": 1, "avg_cost": 1} for i in range(51)]},
        {"holdings": [{"symbol": "VTI", "shares": 1, "avg_cost": 1, "note": "x"}]},
        {"holdings": [{"symbol": "VTI", "shares": "Infinity", "avg_cost": 1}]},
    ]
    for b in bad:
        assert authed.put("/api/holdings", json=b).status_code == 422, b
    assert authed.put("/api/holdings", json={"holdings": []}).status_code == 200
    assert authed.get("/api/holdings").json()["portfolio"]["positions"] == []


def test_contribution(authed: TestClient) -> None:
    _refresh_all(authed)
    body = authed.post("/api/contribution", json={"amount": 500}).json()
    total = sum(a["amount"] for a in body["allocations"]) + body["leftover"]
    assert total == pytest.approx(500, abs=0.05)
    assert {a["symbol"] for a in body["allocations"]} >= {"VTI", "VXUS"}
    for bad in (0, -5, 1e9, "abc"):
        assert authed.post("/api/contribution", json={"amount": bad}).status_code == 422


def test_chart(authed: TestClient) -> None:
    body = authed.get("/api/chart/VTI", params={"days": 365}).json()
    assert 240 <= len(body["points"]) <= 260
    assert all(p["sma200"] is not None for p in body["points"])  # history before window
    assert body["freshness"]["source"] == "fake_prices"
    for e in body["events"]:
        assert e["kind"] in ("golden_cross", "death_cross", "big_up", "big_down")
        assert e["explanation"]
    assert authed.get("/api/chart/TSLA").status_code == 404  # not in plan/candidates/holdings
    assert authed.get("/api/chart/^GSPC").status_code == 200


def test_learn_hides_unverified_links(authed: TestClient) -> None:
    body = authed.get("/api/learn").json()
    assert len(body["glossary"]) >= 30
    assert body["faq"]
    assert body["links"] == []  # none stamped yet in the repo copy
    assert body["pending_links"] >= 10
    terms = {g["term"] for g in body["glossary"]}
    for word in ("VIX (the “fear gauge”)", "VTI", "VXUS", "Percentage point", "Death cross"):
        assert word in terms

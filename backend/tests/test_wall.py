from __future__ import annotations

from datetime import date

import pytest
from fastapi.testclient import TestClient

from keystone_ledger.api.routes_wall import resolve_this_month
from keystone_ledger.core.wall import add_months, build_wall

OCT = date(2026, 10, 1)


def months(*pairs: tuple[int, int]) -> list[tuple[date, float]]:
    return [(date(y, m, 1), 100.0) for y, m in pairs]


def test_empty_wall_has_this_year_and_an_invitation() -> None:
    w = build_wall([], OCT)
    assert [c.year for c in w.courses] == [2026]
    assert w.months_laid == 0
    assert w.current_streak == 0
    states = [s.state for s in w.courses[0].stones]
    assert states[:9] == ["missed"] * 9  # no start yet: honest gaps, nothing invented
    assert states[9] == "open"
    assert states[10:] == ["future", "future"]
    assert "first stone" in w.message


def test_streak_grace_for_the_current_month() -> None:
    w = build_wall(months((2026, 7), (2026, 8), (2026, 9)), OCT)
    assert w.current_streak == 3  # October isn't over, so it doesn't break the streak
    assert not w.this_month_laid
    assert "keep the streak going" in w.message
    w2 = build_wall(months((2026, 7), (2026, 8), (2026, 9), (2026, 10)), OCT)
    assert w2.current_streak == 4
    assert w2.this_month_laid


def test_missed_month_breaks_current_but_not_longest() -> None:
    w = build_wall(months((2026, 1), (2026, 2), (2026, 3), (2026, 4), (2026, 9)), OCT)
    assert w.current_streak == 1
    assert w.longest_streak == 4
    states = {s.month.month: s.state for s in w.courses[0].stones}
    assert states[5] == "missed"
    assert states[9] == "laid"


def test_streak_crosses_years() -> None:
    w = build_wall(months((2025, 11), (2025, 12), (2026, 1)), date(2026, 1, 15))
    assert w.current_streak == 3
    assert [c.year for c in w.courses] == [2026, 2025]  # newest course on top


def test_full_year_earns_a_keystone() -> None:
    entries = [(date(2025, m, 1), 50.0) for m in range(1, 13)]
    w = build_wall(entries, OCT)
    y2025 = next(c for c in w.courses if c.year == 2025)
    assert y2025.keystone
    assert y2025.total == 600.0
    assert w.keystones == 1
    assert not next(c for c in w.courses if c.year == 2026).keystone


def test_december_completion_message() -> None:
    entries = [(date(2026, m, 1), 50.0) for m in range(1, 13)]
    w = build_wall(entries, date(2026, 12, 1))
    assert w.courses[0].keystone
    assert "A full year" in w.message


def test_multiple_entries_in_a_month_sum_into_one_stone() -> None:
    w = build_wall([(date(2026, 3, 1), 200.0), (date(2026, 3, 1), 300.5)], OCT)
    march = w.courses[0].stones[2]
    assert march.state == "laid"
    assert march.amount == 500.5
    assert march.entries == 2
    assert w.total == 500.5
    assert w.months_laid == 1


def test_months_before_first_stone_are_not_counted_as_missed() -> None:
    w = build_wall(months((2026, 6)), OCT)
    states = [s.state for s in w.courses[0].stones]
    assert states[:5] == ["before_start"] * 5
    assert states[6:9] == ["missed"] * 3


def test_future_entries_are_ignored() -> None:
    w = build_wall(months((2027, 1)), OCT)
    assert w.months_laid == 0
    assert w.total == 0


def test_add_months() -> None:
    assert add_months(date(2026, 12, 1), 1) == date(2027, 1, 1)
    assert add_months(date(2026, 1, 1), -1) == date(2025, 12, 1)


@pytest.mark.parametrize(
    ("client", "expected"),
    [
        (None, date(2026, 10, 1)),
        ("2026-10", date(2026, 10, 1)),
        ("2026-11", date(2026, 11, 1)),  # browser already in next month (time zones)
        ("2026-09", date(2026, 9, 1)),
        ("2027-05", date(2026, 10, 1)),  # too far off: ignore the browser
        ("garbage", date(2026, 10, 1)),
    ],
)
def test_resolve_this_month(client: str | None, expected: date) -> None:
    assert resolve_this_month(date(2026, 10, 2), client) == expected


# --- API ----------------------------------------------------------------------------------------


def test_wall_requires_auth_and_csrf(client: TestClient, authed: TestClient) -> None:
    del authed.headers["x-csrf-token"]
    assert (
        authed.post("/api/contributions", json={"month": "2026-10", "amount": 100}).status_code
        == 403
    )


def test_wall_requires_auth(client: TestClient) -> None:
    assert client.get("/api/wall").status_code == 401


def test_log_and_delete_contribution(authed: TestClient) -> None:
    r = authed.post(
        "/api/contributions", json={"month": "2026-10", "amount": 500, "note": " first\nstone "}
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["wall"]["months_laid"] == 1
    assert body["wall"]["this_month_laid"] is True
    assert body["wall"]["current_streak"] == 1
    entry = body["entries"][0]
    assert entry["note"] == "first stone"
    assert entry["amount"] == 500
    authed.post("/api/contributions", json={"month": "2026-09", "amount": 250.555})
    w = authed.get("/api/wall").json()["wall"]
    assert w["current_streak"] == 2
    assert w["total"] == 750.56
    assert authed.delete(f"/api/contributions/{entry['id']}").status_code == 204
    assert authed.delete(f"/api/contributions/{entry['id']}").status_code == 404
    w = authed.get("/api/wall").json()["wall"]
    assert w["months_laid"] == 1
    assert w["this_month_laid"] is False


@pytest.mark.parametrize(
    "body",
    [
        {"month": "2026-12", "amount": 100},  # future
        {"month": "1989-12", "amount": 100},
        {"month": "2026-13", "amount": 100},
        {"month": "Oct 2026", "amount": 100},
        {"month": "2026-10", "amount": 0},
        {"month": "2026-10", "amount": -5},
        {"month": "2026-10", "amount": "Infinity"},
        {"month": "2026-10", "amount": 100, "note": "x" * 121},
        {"month": "2026-10", "amount": 100, "extra": 1},
    ],
)
def test_contribution_validation(authed: TestClient, body: dict[str, object]) -> None:
    assert authed.post("/api/contributions", json=body).status_code == 422


def test_browser_month_allows_next_month_near_boundary(authed: TestClient) -> None:
    # Server clock says Oct 2; a browser already in November (time zone) may log November.
    r = authed.post(
        "/api/contributions", json={"month": "2026-11", "amount": 10, "this_month": "2026-11"}
    )
    assert r.status_code == 201
    assert r.json()["wall"]["this_month"] == "2026-11-01"


def test_messages_pluralize() -> None:
    assert "1 month in a row" in build_wall(months((2026, 10)), OCT).message
    assert "2 months in a row" in build_wall(months((2026, 9), (2026, 10)), OCT).message

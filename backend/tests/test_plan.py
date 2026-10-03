from __future__ import annotations

from datetime import date

import pytest

from keystone_ledger.config import DriftConfig, PlanConfig
from keystone_ledger.core.plan import (
    Quote,
    Target,
    build_targets,
    drift,
    split_contribution,
    value_portfolio,
)

PLAN = PlanConfig()


def _pcts(targets: list[Target]) -> dict[str, float]:
    return {t.symbol: round(t.target_pct, 4) for t in targets}


def test_six_picks_split_forty_percent_equally() -> None:
    t = build_targets(PLAN, [(f"S{i}", "why") for i in range(6)])
    p = _pcts(t)
    assert p["VTI"] == 45 and p["VXUS"] == 15
    assert all(p[f"S{i}"] == pytest.approx(40 / 6, abs=1e-4) for i in range(6))
    assert sum(x.target_pct for x in t) == pytest.approx(100)


def test_few_picks_are_capped_and_excess_goes_to_core() -> None:
    p = _pcts(build_targets(PLAN, [("A", ""), ("B", "")]))
    assert p["A"] == p["B"] == 8.0  # max_single_stock_pct
    assert p["VTI"] == pytest.approx(45 + 24 * 0.75)
    assert p["VXUS"] == pytest.approx(15 + 24 * 0.25)


def test_no_picks_all_core() -> None:
    assert _pcts(build_targets(PLAN, [])) == {"VTI": 75.0, "VXUS": 25.0}


def test_value_portfolio() -> None:
    q = {
        "VTI": Quote(300.0, 297.0, date(2026, 10, 2)),
        "AAPL": Quote(200.0, 205.0, date(2026, 10, 2)),
    }
    s = value_portfolio([("VTI", 10, 250.0), ("AAPL", 5, 150.0), ("XYZ", 1, 10.0)], q)
    assert s.value == 4000.0
    assert s.cost_basis == 3250.0
    assert s.day_change == pytest.approx(30 - 25)
    assert s.day_change_pct == pytest.approx(5 / 3995 * 100)
    assert s.total_change == 750.0
    assert s.total_change_pct == pytest.approx(750 / 3250 * 100)
    assert s.missing_prices == ["XYZ"]


def test_drift_flags_absolute_relative_and_off_plan() -> None:
    targets = [
        Target("VTI", "core", 60.0, ""),
        Target("AAPL", "stock", 6.0, ""),
        Target("MSFT", "stock", 34.0, ""),
    ]
    q = {s: Quote(1.0, 1.0, date(2026, 10, 2)) for s in ("VTI", "AAPL", "MSFT", "GME")}
    # VTI 54% (-6pp), AAPL 7.6% (+1.6pp, 27% relative), MSFT 34%, GME 4.4% off-plan
    s = value_portfolio([("VTI", 540, 1), ("AAPL", 76, 1), ("MSFT", 340, 1), ("GME", 44, 1)], q)
    rows = {r.symbol: r for r in drift(targets, s.positions, s.value, DriftConfig())}
    assert rows["VTI"].flagged and "6.0 percentage points below its target" in rows["VTI"].reason
    assert rows["AAPL"].flagged and "about 27% more than planned" in rows["AAPL"].reason
    assert rows["AAPL"].reason.startswith("1.6 percentage points above")
    assert not rows["MSFT"].flagged
    assert rows["GME"].kind == "off_plan" and rows["GME"].flagged
    assert rows["VTI"].target_value == pytest.approx(600)


TARGETS = [
    Target("VTI", "core", 60, ""),
    Target("VXUS", "core", 20, ""),
    Target("AAPL", "stock", 20, ""),
]
PRICES = {"VTI": 300.0, "VXUS": 60.0, "AAPL": 200.0}


def test_contribution_fills_underweights_first_never_sells() -> None:
    current = {"VTI": 700.0, "VXUS": 100.0, "AAPL": 200.0}  # VTI over, VXUS/AAPL under
    plan = split_contribution(500, TARGETS, current, PRICES, True, 1000)
    by = {a.symbol: a for a in plan.allocations}
    # new total 1500: deficits VTI 200, VXUS 200, AAPL 100 => total 500 exactly
    assert by["VTI"].amount == pytest.approx(200)
    assert by["VXUS"].amount == pytest.approx(200)
    assert by["AAPL"].amount == pytest.approx(100)
    assert by["AAPL"].shares == pytest.approx(0.5)
    assert plan.leftover == pytest.approx(0)
    assert all(a.amount >= 0 for a in plan.allocations)


def test_contribution_smaller_than_deficits_is_proportional() -> None:
    current = {"VTI": 2000.0, "VXUS": 0.0, "AAPL": 0.0}
    plan = split_contribution(100, TARGETS, current, PRICES, True, 2000)
    by = {a.symbol: a.amount for a in plan.allocations}
    assert "VTI" not in by  # overweight gets nothing
    assert by["VXUS"] == pytest.approx(50) and by["AAPL"] == pytest.approx(50)


def test_contribution_on_target_follows_weights() -> None:
    current = {"VTI": 600.0, "VXUS": 200.0, "AAPL": 200.0}
    by = {a.symbol: a.amount for a in split_contribution(1000, TARGETS, current, PRICES, True,
                                                          1000).allocations}  # fmt: skip
    assert by == {"VTI": 600.0, "VXUS": 200.0, "AAPL": 200.0}


def test_whole_shares_spends_leftover_on_most_underweight() -> None:
    plan = split_contribution(1000, TARGETS, {}, PRICES, False, 0)
    spent = sum(a.amount for a in plan.allocations)
    assert spent + plan.leftover == pytest.approx(1000)
    assert plan.leftover < min(PRICES.values())
    assert all(float(a.shares or 0).is_integer() for a in plan.allocations)


def test_contribution_without_price_is_explained() -> None:
    plan = split_contribution(100, TARGETS, {}, {"VTI": 300.0}, True, 0)
    assert "No current price for VXUS, AAPL" in plan.note
    by = {a.symbol: a for a in plan.allocations}
    assert by["VXUS"].shares is None


def test_drift_says_not_owned_yet() -> None:
    targets = [Target("VTI", "core", 60.0, ""), Target("VXUS", "core", 40.0, "")]
    s = value_portfolio([("VTI", 10, 1)], {"VTI": Quote(1.0, 1.0, date(2026, 10, 2))})
    rows = {r.symbol: r for r in drift(targets, s.positions, s.value, DriftConfig())}
    assert rows["VXUS"].flagged
    assert rows["VXUS"].reason == "you don't own any yet"


def test_fractional_split_adds_up_to_the_cent() -> None:
    three = [
        Target("A", "core", 100 / 3, ""),
        Target("B", "core", 100 / 3, ""),
        Target("C", "stock", 100 / 3, ""),
    ]
    plan = split_contribution(500, three, {}, {}, True, 0)
    assert round(sum(a.amount for a in plan.allocations), 2) == 500.0
    assert plan.leftover == 0

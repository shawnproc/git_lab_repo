from __future__ import annotations

import pytest

from keystone_ledger.config import AppConfig, PlanConfig
from keystone_ledger.core.plan import Target, build_targets, sleeve_weights, split_contribution
from keystone_ledger.core.screen import Metrics, ScreenResult
from keystone_ledger.core.valuation import valuation
from keystone_ledger.core.watch import (
    affinity,
    keep_list,
    quarter_of,
    record_quarter,
    status_of,
    trend_of,
)

EMPTY = Metrics(None, {}, None, None, None, None, None, None, None, None, None)


def res(sym: str, ok: bool, score: float | None = 30.0) -> ScreenResult:
    return ScreenResult(sym, "Tech", f"{sym} Inc", EMPTY, (), ok, score)


# --- 2-quarter replacement rule ---------------------------------------------------------------


def test_one_failed_quarter_is_on_watch_two_in_a_row_is_replace() -> None:
    h = record_quarter([], "2026Q1", [res("A", True), res("B", True)])
    h = record_quarter(h, "2026Q2", [res("A", False), res("B", True)])
    assert status_of("A", h, 2) == "watch"
    assert status_of("B", h, 2) == "ok"
    h = record_quarter(h, "2026Q3", [res("A", False), res("B", False)])
    assert status_of("A", h, 2) == "replace"
    assert status_of("B", h, 2) == "watch"


def test_a_pass_resets_the_streak_and_same_quarter_reruns_replace_not_stack() -> None:
    h = record_quarter([], "2026Q1", [res("A", False)])
    h = record_quarter(h, "2026Q1", [res("A", False)])  # daily reruns in one quarter
    assert len(h) == 1 and status_of("A", h, 2) == "watch"
    h = record_quarter(h, "2026Q2", [res("A", True)])
    h = record_quarter(h, "2026Q3", [res("A", False)])
    assert status_of("A", h, 2) == "watch"  # not replace: the Q2 pass broke the streak


def test_history_is_bounded_and_quarters_are_calendar_quarters() -> None:
    from datetime import date

    h: list[dict[str, object]] = []
    for y in range(2020, 2026):
        for q in range(1, 5):
            h = record_quarter(h, f"{y}Q{q}", [res("A", True)])
    assert len(h) == 12 and h[-1]["quarter"] == "2025Q4"
    assert quarter_of(date(2026, 10, 5)) == "2026Q4"


def test_previous_picks_stay_unless_replaced() -> None:
    assert keep_list(["A", "B", "C"], {"A": "watch", "B": "replace"}) == ["A", "C"]


# --- affinity -----------------------------------------------------------------------------------


def test_affinity_grows_for_strong_improving_and_backs_off_for_weak_or_watched() -> None:
    picks = [res("STRONG", True, 60.0), res("MID", True, 30.0), res("WEAK", True, 15.0),
             res("WATCH", False, 30.0)]  # fmt: skip
    a = affinity(
        picks,
        {"WATCH": "watch"},
        {"STRONG": "improving", "WEAK": "weakening", "MID": "steady", "WATCH": "steady"},
    )
    assert a["STRONG"].weight == pytest.approx(1.8)  # 1.5 (capped) x 1.2
    assert a["MID"].weight == pytest.approx(1.0)
    assert a["WEAK"].weight == pytest.approx(0.4)  # 0.5 x 0.8
    assert a["WATCH"].weight == pytest.approx(0.5)
    assert "got stronger" in a["STRONG"].reason
    assert "on watch" in a["WATCH"].reason


def test_trend_needs_two_scored_quarters() -> None:
    h = record_quarter([], "2026Q1", [res("A", True, 20.0)])
    assert trend_of("A", h) == "new"
    h = record_quarter(h, "2026Q2", [res("A", True, 23.0)])
    assert trend_of("A", h) == "improving"
    h = record_quarter(h, "2026Q3", [res("A", True, 22.0)])
    assert trend_of("A", h) == "steady"


# --- valuation -------------------------------------------------------------------------------


def test_pe_well_above_its_own_median_is_flagged() -> None:
    eps = {2021: 2.0, 2022: 2.0, 2023: 2.0, 2024: 2.0, 2025: 2.0}
    closes = {2021: 40.0, 2022: 40.0, 2023: 50.0, 2024: 40.0, 2025: 40.0}  # P/E 20,20,25,20,20
    v = valuation(eps, closes, last_close=62.0, multiple=1.5)  # P/E 31 > 1.5 x 20
    assert v.flagged and v.pe == 31.0 and v.median_pe == 20.0
    assert "well above its usual $20" in v.detail
    assert not valuation(eps, closes, last_close=58.0, multiple=1.5).flagged  # P/E 29


def test_losses_and_short_history_never_flag() -> None:
    assert not valuation({2025: -1.0}, {2025: 10.0}, 10.0, 1.5).flagged
    short = valuation({2024: 1.0, 2025: 1.0}, {2024: 10.0, 2025: 10.0}, 50.0, 1.5)
    assert short.pe == 50.0 and short.median_pe is None and not short.flagged
    assert not valuation({}, {}, None, 1.5).flagged


# --- allocation math --------------------------------------------------------------------------


def test_sleeve_weights_cap_and_redistribute() -> None:
    # 40% across weights 3:1:1:1 with an 8% cap: 20 > 8, so 8 and the rest (32) split 3 ways.
    assert sleeve_weights(40, [3, 1, 1, 1], 8) == pytest.approx([8, 8, 8, 8])
    assert sleeve_weights(40, [2, 1, 1, 1, 1, 1, 1, 1, 1, 1], 8) == pytest.approx(
        [40 * 2 / 11] + [40 / 11] * 9
    )
    assert sum(sleeve_weights(40, [1, 1], 8)) == pytest.approx(16)  # both capped


def test_targets_follow_the_chosen_split_and_always_sum_to_100() -> None:
    plan = PlanConfig()
    picks = [(f"S{i}", "") for i in range(10)]
    for stocks in (40.0, 30.0, 20.0):
        t = build_targets(plan, picks, stocks_pct=stocks)
        assert sum(x.target_pct for x in t) == pytest.approx(100)
        assert sum(x.target_pct for x in t if x.kind == "stock") == pytest.approx(stocks)
    by = {x.symbol: x.target_pct for x in build_targets(plan, picks, stocks_pct=20.0)}
    assert by["VTI"] == pytest.approx(60.0) and by["VXUS"] == pytest.approx(20.0)  # 45:15 kept
    assert by["S0"] == pytest.approx(2.0)


def test_buy_day_money_skips_flagged_holdings() -> None:
    targets = [Target("VTI", "core", 60, ""), Target("AAA", "stock", 20, ""),
               Target("BBB", "stock", 20, "")]  # fmt: skip
    current = {"VTI": 600.0, "AAA": 0.0, "BBB": 100.0}
    plan = split_contribution(300, targets, current, {}, True, 700, skip={"AAA"})
    got = {a.symbol: a.amount for a in plan.allocations}
    assert "AAA" not in got  # most behind, but price-flagged: its share goes elsewhere
    assert sum(got.values()) == pytest.approx(300)
    assert got["BBB"] > 0
    # Skipping everything would leave nowhere to go, so then nothing is skipped.
    allskip = split_contribution(100, targets, current, {}, True, 700, skip={"VTI", "AAA", "BBB"})
    assert sum(a.amount for a in allskip.allocations) == pytest.approx(100)


def test_example_config_has_the_new_rules() -> None:
    c = AppConfig()
    assert c.screen.replace_after_failed_quarters == 2
    assert c.screen.valuation_pe_multiple == 1.5


def test_a_stock_split_never_mixes_before_and_after_years() -> None:
    from datetime import date

    # 10-for-1 split in June 2024: split-adjusted closes, but EPS as filed (pre-split years 10x).
    eps = {2021: 30.0, 2022: 30.0, 2023: 30.0, 2024: 3.0, 2025: 3.0}
    closes = {2021: 60.0, 2022: 60.0, 2023: 60.0, 2024: 60.0, 2025: 60.0}
    split = {date(2024, 6, 10): 10.0}
    # Without the rule the old years would read P/E 2 and make today's 20 look wildly high.
    assert valuation(eps, closes, 60.0, 1.5).flagged
    v = valuation(eps, closes, 60.0, 1.5, split)
    assert v.years_used == [2024, 2025] and v.median_pe is None and not v.flagged
    assert "since its last stock split" in v.detail


def test_a_split_after_the_latest_report_waits() -> None:
    from datetime import date

    v = valuation({2024: 3.0, 2025: 3.0}, {2024: 60.0, 2025: 60.0}, 6.0, 1.5,
                  {date(2026, 6, 1): 10.0})  # fmt: skip
    assert v.pe is None and not v.flagged and "waits for the next report" in v.detail

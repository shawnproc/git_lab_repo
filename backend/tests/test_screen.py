from __future__ import annotations

import pytest

from keystone_ledger.config import ScreenConfig
from keystone_ledger.core.screen import (
    Candidate,
    compute_metrics,
    duration_period,
    instant_period,
    run_checks,
    screen,
)

from .conftest import COMPANIES, company_values

YEARS = [2025, 2024, 2023, 2022, 2021]
CFG = ScreenConfig()


def facts_for(name: str, years: list[int] = YEARS) -> dict[tuple[str, str], float]:
    out: dict[tuple[str, str], float] = {}
    for y in years:
        v = company_values(name, y)
        out[("RevenueFromContractWithCustomerExcludingAssessedTax", duration_period(y))] = v["rev"]
        out[("OperatingIncomeLoss", duration_period(y))] = v["oi"]
        out[("NetCashProvidedByUsedInOperatingActivities", duration_period(y))] = v["cfo"]
        out[("PaymentsToAcquirePropertyPlantAndEquipment", duration_period(y))] = v["capex"]
        out[("LongTermDebt", instant_period(y))] = v["debt"]
    return out


def test_metrics_against_known_values() -> None:
    m = compute_metrics(facts_for("AAPL"), YEARS, 3)
    assert m.latest_year == 2025
    assert m.revenue_cagr == pytest.approx(0.08)
    assert m.cagr_from_year == 2022
    assert m.operating_margin == pytest.approx(0.32)
    assert m.operating_margin_prior == pytest.approx(0.30)
    assert m.fcf_margin == pytest.approx(0.25)
    assert m.debt_to_operating_income == pytest.approx(0.9)


def test_revenue_tag_fallback_per_year() -> None:
    f = facts_for("AAPL")
    # Older years filed under a legacy tag.
    for y in (2021, 2022):
        key = ("RevenueFromContractWithCustomerExcludingAssessedTax", duration_period(y))
        f[("SalesRevenueNet", duration_period(y))] = f.pop(key)
    assert compute_metrics(f, YEARS, 3).revenue_cagr == pytest.approx(0.08)


def test_missing_data_is_unavailable_not_guessed() -> None:
    f = {
        k: v
        for k, v in facts_for("AAPL").items()
        if k[0] not in ("LongTermDebt", "PaymentsToAcquirePropertyPlantAndEquipment")
    }
    m = compute_metrics(f, YEARS, 3)
    checks = {c.key: c.status for c in run_checks(m, CFG)}
    assert checks == {
        "revenue_growth": "pass",
        "margin_level": "pass",
        "margin_trend": "pass",
        "fcf": "unavailable",
        "debt": "unavailable",
    }
    assert compute_metrics({}, YEARS, 3).latest_year is None


def test_short_history_makes_growth_unavailable() -> None:
    m = compute_metrics(facts_for("AAPL", [2025, 2024]), YEARS, 3)
    assert m.revenue_cagr is None
    assert {c.key: c.status for c in run_checks(m, CFG)}["revenue_growth"] == "unavailable"


def test_failures() -> None:
    nke = {c.key: c.status for c in run_checks(compute_metrics(facts_for("NKE"), YEARS, 3), CFG)}
    assert nke["revenue_growth"] == "fail"
    assert nke["margin_level"] == "fail"
    assert nke["margin_trend"] == "fail"
    orcl = {c.key: c.status for c in run_checks(compute_metrics(facts_for("ORCL"), YEARS, 3), CFG)}
    assert orcl["debt"] == "fail"


def test_operating_loss_fails_debt_check() -> None:
    f = facts_for("AAPL")
    f[("OperatingIncomeLoss", duration_period(2025))] = -1e9
    checks = {c.key: c for c in run_checks(compute_metrics(f, YEARS, 3), CFG)}
    assert checks["debt"].status == "fail"


SECTORS = {
    "AAPL": "Technology",
    "MSFT": "Technology",
    "NVDA": "Technology",
    "ORCL": "Technology",
    "KO": "Consumer Staples",
    "NKE": "Consumer Discretionary",
    "XOM": "Energy",
    "LLY": "Health Care",
}


def test_screen_ranks_caps_sector_and_explains() -> None:
    cands = [Candidate(s, sec, f"{s} Corp", facts_for(s)) for s, sec in SECTORS.items()]
    cands.append(Candidate("ZZZ", "Energy", "ZZZ", {}, note="no SEC filer found"))
    res = screen(cands, YEARS, CFG, max_stocks=6, max_per_sector=2)
    picked = [r.symbol for r in res if r.picked]
    # NVDA > MSFT > LLY > AAPL > KO by score; AAPL is blocked by the 2-per-sector cap.
    assert picked == ["NVDA", "MSFT", "LLY", "KO"]
    by = {r.symbol: r for r in res}
    assert not by["AAPL"].picked and by["AAPL"].qualifies
    assert not by["ORCL"].qualifies and not by["NKE"].qualifies and not by["XOM"].qualifies
    assert by["ZZZ"].note == "no SEC filer found"
    why = by["MSFT"].why
    assert "14.0% a year from 2022 to 2025" in why
    assert "SEC filings" in why
    assert 2 <= len([p for p in why.split(". ") if p]) <= 3  # 2-3 sentences
    assert by["AAPL"].why == ""


def test_screen_respects_max_stocks() -> None:
    cands = [Candidate(s, f"S{i}", s, facts_for(s)) for i, s in enumerate(SECTORS)]
    assert sum(r.picked for r in screen(cands, YEARS, CFG, max_stocks=2, max_per_sector=2)) == 2


def test_all_fixture_companies_have_known_shape() -> None:
    assert set(SECTORS) <= set(COMPANIES)

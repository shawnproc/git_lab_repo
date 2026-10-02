"""Quality-stock screen from SEC XBRL facts. Pure functions: no I/O, no clock.

Each candidate gets five named checks, each `pass`, `fail` or `unavailable`. A metric we can't
compute from filed data is "unavailable", never estimated.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Literal

from keystone_ledger.config import ScreenConfig

# Revenue has been reported under several tags over the years; first match wins per year.
REVENUE_TAGS = (
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "Revenues",
    "SalesRevenueNet",
    "RevenueFromContractWithCustomerIncludingAssessedTax",
)
OPERATING_INCOME_TAGS = ("OperatingIncomeLoss",)
CFO_TAGS = ("NetCashProvidedByUsedInOperatingActivities",)
CAPEX_TAGS = ("PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets")
DEBT_TAGS = ("LongTermDebt", "LongTermDebtNoncurrent")

DURATION_TAGS = (*REVENUE_TAGS, *OPERATING_INCOME_TAGS, *CFO_TAGS, *CAPEX_TAGS)
INSTANT_TAGS = DEBT_TAGS

Status = Literal["pass", "fail", "unavailable"]
# Facts for one company: {(tag, period): value}; periods are "CY2024" or "CY2024Q4I".
Facts = Mapping[tuple[str, str], float]


def duration_period(year: int) -> str:
    return f"CY{year}"


def instant_period(year: int) -> str:
    return f"CY{year}Q4I"


def _first(facts: Facts, tags: tuple[str, ...], period: str) -> float | None:
    for t in tags:
        v = facts.get((t, period))
        if v is not None:
            return v
    return None


@dataclass(frozen=True)
class Metrics:
    latest_year: int | None
    revenue: dict[int, float]
    revenue_cagr: float | None  # fraction, e.g. 0.12
    cagr_from_year: int | None
    operating_margin: float | None
    operating_margin_prior: float | None  # two years before latest
    fcf: float | None
    fcf_margin: float | None
    debt: float | None
    debt_to_operating_income: float | None
    operating_income: float | None


def compute_metrics(facts: Facts, years: list[int], revenue_years: int) -> Metrics:
    revenue = {
        y: v for y in years if (v := _first(facts, REVENUE_TAGS, duration_period(y))) is not None
    }
    latest = max(revenue) if revenue else None
    if latest is None:
        return Metrics(None, {}, None, None, None, None, None, None, None, None, None)

    def opinc(y: int) -> float | None:
        return _first(facts, OPERATING_INCOME_TAGS, duration_period(y))

    base_year = latest - revenue_years
    cagr = None
    if base_year in revenue and revenue[base_year] > 0 and revenue[latest] > 0:
        cagr = (revenue[latest] / revenue[base_year]) ** (1 / revenue_years) - 1

    def margin(y: int) -> float | None:
        oi, rev = opinc(y), revenue.get(y)
        return oi / rev if oi is not None and rev else None

    cfo = _first(facts, CFO_TAGS, duration_period(latest))
    capex = _first(facts, CAPEX_TAGS, duration_period(latest))
    fcf = cfo - capex if cfo is not None and capex is not None else None
    debt = _first(facts, DEBT_TAGS, instant_period(latest))
    oi = opinc(latest)
    d2oi = debt / oi if debt is not None and oi is not None and oi > 0 else None
    return Metrics(
        latest_year=latest,
        revenue=revenue,
        revenue_cagr=cagr,
        cagr_from_year=base_year if cagr is not None else None,
        operating_margin=margin(latest),
        operating_margin_prior=margin(latest - 2),
        fcf=fcf,
        fcf_margin=fcf / revenue[latest] if fcf is not None and revenue[latest] else None,
        debt=debt,
        debt_to_operating_income=d2oi,
        operating_income=oi,
    )


@dataclass(frozen=True)
class Check:
    key: str
    label: str
    status: Status
    detail: str


@dataclass(frozen=True)
class ScreenResult:
    symbol: str
    sector: str
    company: str
    metrics: Metrics
    checks: tuple[Check, ...]
    qualifies: bool
    score: float | None
    why: str = ""
    picked: bool = False
    note: str = ""


def _pct(x: float) -> str:
    return f"{x * 100:.1f}%"


def _money(x: float) -> str:
    sign = "-" if x < 0 else ""
    x = abs(x)
    for unit, div in (("T", 1e12), ("B", 1e9), ("M", 1e6)):
        if x >= div:
            return f"{sign}${x / div:.1f}{unit}"
    return f"{sign}${x:,.0f}"


def _ok(ok: bool) -> Status:
    return "pass" if ok else "fail"


def run_checks(m: Metrics, cfg: ScreenConfig) -> tuple[Check, ...]:
    checks: list[Check] = []
    na: Status = "unavailable"
    if m.revenue_cagr is None:
        checks.append(Check("revenue_growth", "Revenue growth", na, "Not enough filed years."))
    else:
        ok = m.revenue_cagr * 100 >= cfg.min_revenue_cagr_pct
        checks.append(
            Check(
                "revenue_growth",
                "Revenue growth",
                _ok(ok),
                f"{_pct(m.revenue_cagr)}/yr over {cfg.revenue_years} years "
                f"(need ≥ {cfg.min_revenue_cagr_pct:g}%).",
            )
        )
    if m.operating_margin is None:
        checks.append(Check("margin_level", "Operating margin", na, "Operating income not filed."))
    else:
        ok = m.operating_margin * 100 >= cfg.min_operating_margin_pct
        checks.append(
            Check(
                "margin_level",
                "Operating margin",
                _ok(ok),
                f"{_pct(m.operating_margin)} (need ≥ {cfg.min_operating_margin_pct:g}%).",
            )
        )
    if m.operating_margin is None or m.operating_margin_prior is None:
        checks.append(Check("margin_trend", "Margin trend", na, "Need margins two years apart."))
    else:
        delta_pp = (m.operating_margin - m.operating_margin_prior) * 100
        ok = delta_pp >= -cfg.margin_trend_tolerance_pp
        checks.append(
            Check(
                "margin_trend",
                "Margin trend",
                _ok(ok),
                f"{delta_pp:+.1f} points vs two years earlier "
                f"(allowed to slip {cfg.margin_trend_tolerance_pp:g}).",
            )
        )
    if m.fcf is None:
        checks.append(Check("fcf", "Free cash flow", na, "Cash flow or capex not filed."))
    else:
        ok = m.fcf > 0 or not cfg.require_positive_fcf
        checks.append(
            Check(
                "fcf",
                "Free cash flow",
                _ok(ok),
                f"{_money(m.fcf)} (operating cash flow minus capital spending).",
            )
        )
    if m.operating_income is not None and m.operating_income <= 0:
        checks.append(Check("debt", "Debt load", "fail", "No operating profit to cover debt."))
    elif m.debt_to_operating_income is None:
        checks.append(Check("debt", "Debt load", na, "Long-term debt not filed."))
    else:
        ok = m.debt_to_operating_income <= cfg.max_debt_to_operating_income
        checks.append(
            Check(
                "debt",
                "Debt load",
                _ok(ok),
                f"{m.debt_to_operating_income:.1f} years of operating profit "
                f"(need ≤ {cfg.max_debt_to_operating_income:g}).",
            )
        )
    return tuple(checks)


def score(m: Metrics) -> float | None:
    """Growth plus profitability, in percentage points. Simple on purpose: easy to audit."""
    if m.revenue_cagr is None or m.operating_margin is None:
        return None
    return round((m.revenue_cagr + m.operating_margin) * 100, 2)


def stock_why(r: ScreenResult) -> str:
    m = r.metrics
    parts: list[str] = []
    if m.revenue_cagr is not None and m.cagr_from_year and m.latest_year:
        parts.append(
            f"{r.company} grew revenue {_pct(m.revenue_cagr)} a year from {m.cagr_from_year} "
            f"to {m.latest_year}, per its SEC filings."
        )
    if m.operating_margin is not None:
        trend = ""
        if m.operating_margin_prior is not None:
            trend = f", versus {_pct(m.operating_margin_prior)} two years earlier"
        parts.append(f"It keeps {_pct(m.operating_margin)} of sales as operating profit{trend}.")
    tail: list[str] = []
    if m.fcf is not None:
        tail.append(f"generated {_money(m.fcf)} of free cash flow")
    if m.debt_to_operating_income is not None:
        tail.append(f"carries debt equal to {m.debt_to_operating_income:.1f} years of profit")
    if tail:
        parts.append("It " + " and ".join(tail) + ".")
    return " ".join(parts[:3])


@dataclass(frozen=True)
class Candidate:
    symbol: str
    sector: str
    company: str
    facts: Facts = field(default_factory=dict)
    note: str = ""  # e.g. "no SEC CIK for ticker"


def screen(
    candidates: list[Candidate],
    years: list[int],
    cfg: ScreenConfig,
    max_stocks: int,
    max_per_sector: int,
) -> list[ScreenResult]:
    """Run checks for every candidate, then pick the top `max_stocks` qualifiers.

    Qualify: no failed check and at most `cfg.max_unavailable` unavailable ones.
    Rank by `score`, ties by symbol; at most `max_per_sector` picks per sector.
    """
    results: list[ScreenResult] = []
    for c in candidates:
        m = compute_metrics(c.facts, years, cfg.revenue_years)
        checks = run_checks(m, cfg)
        fails = sum(ch.status == "fail" for ch in checks)
        unavailable = sum(ch.status == "unavailable" for ch in checks)
        sc = score(m)
        ok = m.latest_year is not None and fails == 0 and unavailable <= cfg.max_unavailable
        results.append(
            ScreenResult(c.symbol, c.sector, c.company, m, checks, ok and sc is not None, sc,
                         note=c.note)
        )  # fmt: skip

    ranked = sorted(
        (r for r in results if r.qualifies),
        key=lambda r: (-(r.score or 0.0), r.symbol),
    )
    picked: set[str] = set()
    per_sector: dict[str, int] = {}
    for r in ranked:
        if len(picked) >= max_stocks:
            break
        if per_sector.get(r.sector, 0) >= max_per_sector:
            continue
        picked.add(r.symbol)
        per_sector[r.sector] = per_sector.get(r.sector, 0) + 1

    out = []
    for r in results:
        is_picked = r.symbol in picked
        out.append(
            ScreenResult(
                r.symbol, r.sector, r.company, r.metrics, r.checks, r.qualifies, r.score,
                why=stock_why(r) if is_picked else "", picked=is_picked, note=r.note,
            )
        )  # fmt: skip
    out.sort(key=lambda r: (not r.picked, not r.qualifies, -(r.score or -1e9), r.symbol))
    return out

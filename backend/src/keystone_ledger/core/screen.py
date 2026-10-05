"""Quality-stock screen from SEC XBRL facts. Pure functions: no I/O, no clock.

Each candidate gets five named checks, each `pass`, `fail` or `unavailable`. A metric we can't
compute from filed data is "unavailable", never estimated.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
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
# Earnings per share (dollars per share, a different SEC unit), for the price check.
EPS_TAGS = ("EarningsPerShareDiluted", "EarningsPerShareBasic")
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


def _cents(x: float) -> str:
    """0.442 -> '44¢' (share of each sales dollar)."""
    return f"{x * 100:.0f}¢"


def _money(x: float) -> str:
    sign = "-" if x < 0 else ""
    x = abs(x)
    for unit, div in (("trillion", 1e12), ("billion", 1e9), ("million", 1e6)):
        if x >= div:
            return f"{sign}${x / div:.1f} {unit}"
    return f"{sign}${x:,.0f}"


def _ok(ok: bool) -> Status:
    return "pass" if ok else "fail"


NOT_REPORTED = (
    "The company's official reports don't include this number in a form we can read, "
    "so we skip this test instead of guessing."
)


def run_checks(m: Metrics, cfg: ScreenConfig) -> tuple[Check, ...]:
    """Five yes/no tests, each worded as a plain question with a plain answer."""
    checks: list[Check] = []
    na: Status = "unavailable"
    yrs = cfg.revenue_years

    q = "Are sales growing?"
    if m.revenue_cagr is None:
        checks.append(Check("revenue_growth", q, na, f"Needs {yrs + 1} years of reports. "
                            + NOT_REPORTED))  # fmt: skip
    else:
        ok = m.revenue_cagr * 100 >= cfg.min_revenue_cagr_pct
        checks.append(
            Check("revenue_growth", q, _ok(ok),
                  f"Sales grew about {_pct(m.revenue_cagr)} a year over the last {yrs} years. "
                  f"We look for at least {cfg.min_revenue_cagr_pct:g}% a year.")
        )  # fmt: skip

    q = "Is it profitable?"
    if m.operating_margin is None:
        checks.append(Check("margin_level", q, na, NOT_REPORTED))
    else:
        ok = m.operating_margin * 100 >= cfg.min_operating_margin_pct
        checks.append(
            Check("margin_level", q, _ok(ok),
                  f"From every $1 of sales it keeps {_cents(m.operating_margin)} as profit "
                  f"(before taxes). We look for at least {cfg.min_operating_margin_pct:g}¢.")
        )  # fmt: skip

    q = "Is profit holding up?"
    if m.operating_margin is None or m.operating_margin_prior is None:
        checks.append(Check("margin_trend", q, na, NOT_REPORTED))
    else:
        delta_pp = (m.operating_margin - m.operating_margin_prior) * 100
        ok = delta_pp >= -cfg.margin_trend_tolerance_pp
        verdict = "holding up" if ok else "shrinking"
        checks.append(
            Check("margin_trend", q, _ok(ok),
                  f"Profit per $1 of sales went from {_cents(m.operating_margin_prior)} two "
                  f"years ago to {_cents(m.operating_margin)} now: {verdict}.")
        )  # fmt: skip

    q = "Does real cash come in?"
    if m.fcf is None:
        checks.append(Check("fcf", q, na, NOT_REPORTED))
    else:
        ok = m.fcf > 0 or not cfg.require_positive_fcf
        result = (
            f"it had {_money(m.fcf)} left over"
            if m.fcf > 0
            else f"it came up {_money(abs(m.fcf))} short"
        )
        checks.append(
            Check("fcf", q, _ok(ok),
                  f"After paying to run the business and buy equipment, {result} last year.")
        )  # fmt: skip

    q = "Is the debt manageable?"
    limit = cfg.max_debt_to_operating_income
    if m.operating_income is not None and m.operating_income <= 0:
        checks.append(Check("debt", q, "fail", "It made no profit last year, so it has nothing "
                            "to pay its debt down with."))  # fmt: skip
    elif m.debt_to_operating_income is None:
        checks.append(Check("debt", q, na, NOT_REPORTED))
    else:
        ok = m.debt_to_operating_income <= limit
        years = m.debt_to_operating_income
        span = "less than a year" if years < 1 else f"about {years:.1f} years"
        checks.append(
            Check("debt", q, _ok(ok),
                  f"It could pay off its long-term debt with {span} of profit. "
                  f"We look for {limit:g} years or less.")
        )  # fmt: skip
    return tuple(checks)


def score(m: Metrics) -> float | None:
    """Growth plus profitability, in percentage points. Simple on purpose: easy to audit."""
    if m.revenue_cagr is None or m.operating_margin is None:
        return None
    return round((m.revenue_cagr + m.operating_margin) * 100, 2)


def stock_why(r: ScreenResult) -> str:
    """2-3 plain sentences built only from filed numbers."""
    m = r.metrics
    parts: list[str] = []
    if m.revenue_cagr is not None and m.cagr_from_year and m.latest_year:
        parts.append(
            f"{r.company}'s sales grew about {m.revenue_cagr * 100:.0f}% a year from "
            f"{m.cagr_from_year} to {m.latest_year} (from its official SEC reports)."
        )
    if m.operating_margin is not None:
        trend = ""
        if m.operating_margin_prior is not None:
            word = "up from" if m.operating_margin >= m.operating_margin_prior else "down from"
            trend = f", {word} {_cents(m.operating_margin_prior)} two years earlier"
        parts.append(
            f"It keeps {_cents(m.operating_margin)} of every $1 of sales as profit{trend}."
        )
    tail: list[str] = []
    if m.fcf is not None and m.fcf > 0:
        tail.append(f"had {_money(m.fcf)} of cash left over after paying its bills")
    if m.debt_to_operating_income is not None:
        years = m.debt_to_operating_income
        span = "less than a year" if years < 1 else f"about {years:.1f} years"
        tail.append(f"could pay off its long-term debt with {span} of profit")
    if tail:
        parts.append("Last year it " + ", and ".join(tail) + ".")
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
    keep: Sequence[str] = (),
) -> list[ScreenResult]:
    """Run checks for every candidate, then pick up to `max_stocks`.

    `keep` (last time's picks that aren't up for replacement) stay picked first, even if another
    company now ranks higher, so the plan doesn't churn. Open slots go to qualifiers ranked by
    `score` (ties by symbol), at most `max_per_sector` per sector.
    Qualify: no failed check and at most `cfg.max_unavailable` unavailable ones.
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
    by_symbol = {r.symbol: r for r in results}
    for sym in keep:
        r = by_symbol.get(sym)
        if r is None or sym in picked or len(picked) >= max_stocks:
            continue
        picked.add(sym)
        per_sector[r.sector] = per_sector.get(r.sector, 0) + 1
    for r in ranked:
        if r.symbol in picked:
            continue
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

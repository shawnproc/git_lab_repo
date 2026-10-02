"""Dashboard, plan, holdings, contribution, charts and Learn endpoints."""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Annotated

from fastapi import APIRouter, HTTPException, Path, Query
from pydantic import BaseModel, ConfigDict, Field, field_validator

from keystone_ledger.api.deps import CsrfPrincipalDep, DbDep, PrincipalDep, StateDep
from keystone_ledger.core.chart import ChartEvent, big_moves, crossovers, sma
from keystone_ledger.core.mood import MoodResult
from keystone_ledger.core.plan import ContributionPlan, DriftRow, PortfolioSummary, Target
from keystone_ledger.core.screen import ScreenResult
from keystone_ledger.data.base import SYMBOL_RE, validate_symbol
from keystone_ledger.data.fundamentals import FundamentalsStatus
from keystone_ledger.data.service import Freshness
from keystone_ledger.db.session import transaction
from keystone_ledger.learn import LearnContent, load_learn

router = APIRouter(prefix="/api", tags=["plan"])

MAX_HOLDINGS = 50


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


# --- dashboard ---------------------------------------------------------------------------------


@dataclass(frozen=True)
class DashboardOut:
    mood: MoodResult
    index_freshness: Freshness
    vix_freshness: Freshness
    portfolio: PortfolioSummary
    holdings_freshness: dict[str, Freshness]
    any_stale: bool


@router.get("/dashboard", response_model=DashboardOut)
def dashboard(state: StateDep, db: DbDep, _p: PrincipalDep) -> DashboardOut:
    mood, idx_f, vix_f = state.planner.mood()
    pv = state.planner.portfolio(db)
    stale = idx_f.stale or vix_f.stale or any(f.stale for f in pv.freshness.values())
    return DashboardOut(mood, idx_f, vix_f, pv.summary, pv.freshness, stale)


@router.post("/market/refresh", response_model=DashboardOut)
def refresh_market(state: StateDep, db: DbDep, p: CsrfPrincipalDep) -> DashboardOut:
    state.planner.refresh_market(db)
    return dashboard(state, db, p)


# --- plan --------------------------------------------------------------------------------------


@dataclass(frozen=True)
class TargetOut:
    symbol: str
    kind: str
    target_pct: float
    target_value: float
    why: str


@dataclass(frozen=True)
class PlanOut:
    targets: list[TargetOut]
    screen: list[ScreenResult]
    fundamentals: FundamentalsStatus
    basis_value: float
    basis_is_reference: bool


def _targets_out(targets: list[Target], basis: float) -> list[TargetOut]:
    return [
        TargetOut(t.symbol, t.kind, round(t.target_pct, 4), round(t.target_pct / 100 * basis, 2),
                  t.why)
        for t in targets
    ]  # fmt: skip


@router.get("/plan", response_model=PlanOut)
def plan(state: StateDep, db: DbDep, _p: PrincipalDep) -> PlanOut:
    v = state.planner.plan(db)
    return PlanOut(
        _targets_out(v.targets, v.basis_value), v.screen, v.fundamentals, v.basis_value,
        v.basis_is_reference,
    )  # fmt: skip


@router.post("/plan/refresh", response_model=PlanOut)
def refresh_plan(state: StateDep, db: DbDep, p: CsrfPrincipalDep) -> PlanOut:
    """Refresh SEC fundamentals if older than `fundamentals_max_age_days` (no-op otherwise)."""
    state.fundamentals.refresh(list(state.config.plan.candidates))
    return plan(state, db, p)


# --- holdings ----------------------------------------------------------------------------------


class HoldingIn(_Strict):
    symbol: Annotated[str, Field(min_length=1, max_length=16)]
    shares: Annotated[float, Field(gt=0, le=1e9, allow_inf_nan=False)]
    avg_cost: Annotated[float, Field(ge=0, le=1e7, allow_inf_nan=False)]

    @field_validator("symbol")
    @classmethod
    def _sym(cls, v: str) -> str:
        return validate_symbol(v)


class HoldingsIn(_Strict):
    holdings: Annotated[list[HoldingIn], Field(max_length=MAX_HOLDINGS)]

    @field_validator("holdings")
    @classmethod
    def _unique(cls, v: list[HoldingIn]) -> list[HoldingIn]:
        syms = [h.symbol for h in v]
        if len(set(syms)) != len(syms):
            raise ValueError("each symbol may appear only once")
        return v


@dataclass(frozen=True)
class HoldingsOut:
    drift: list[DriftRow]
    portfolio: PortfolioSummary
    freshness: dict[str, Freshness]


@router.get("/holdings", response_model=HoldingsOut)
def holdings(state: StateDep, db: DbDep, _p: PrincipalDep) -> HoldingsOut:
    rows, pv, _ = state.planner.drift(db)
    return HoldingsOut(rows, pv.summary, pv.freshness)


@router.put("/holdings", response_model=HoldingsOut)
def put_holdings(body: HoldingsIn, state: StateDep, p: CsrfPrincipalDep) -> HoldingsOut:
    with transaction(state.session_factory) as s:
        state.planner.replace_holdings(
            s, [(h.symbol, h.shares, h.avg_cost) for h in body.holdings], state.market.clock()
        )
    # Committed first; then fetch prices so values show immediately (cached afterwards).
    for h in body.holdings:
        state.market.refresh_bars(h.symbol)
    with state.session_factory() as s:
        return holdings(state, s, p)


# --- contribution ------------------------------------------------------------------------------


class ContributionIn(_Strict):
    amount: Annotated[float, Field(gt=0, le=10_000_000, allow_inf_nan=False)]


@router.post("/contribution", response_model=ContributionPlan)
def contribution(
    body: ContributionIn, state: StateDep, db: DbDep, _p: CsrfPrincipalDep
) -> ContributionPlan:
    return state.planner.contribution(db, body.amount)


# --- charts ------------------------------------------------------------------------------------


@dataclass(frozen=True)
class ChartPoint:
    day: date
    open: float
    high: float
    low: float
    close: float
    sma50: float | None
    sma200: float | None


@dataclass(frozen=True)
class ChartOut:
    symbol: str
    freshness: Freshness
    points: list[ChartPoint]
    events: list[ChartEvent]


SymbolPath = Annotated[str, Path(min_length=1, max_length=16, pattern=SYMBOL_RE.pattern)]


@router.get("/chart/{symbol}", response_model=ChartOut)
def chart(
    symbol: SymbolPath,
    state: StateDep,
    db: DbDep,
    _p: PrincipalDep,
    days: Annotated[int, Query(ge=30, le=365 * 10)] = 365 * 2,
) -> ChartOut:
    sym = validate_symbol(symbol)
    if sym not in state.planner.chartable(db):
        raise HTTPException(404, "symbol is not in your plan, candidates or holdings")
    # Compute indicators over all cached history, then trim, so lines are valid from day one.
    res = state.market.get_bars(sym, refresh=True)
    bars = res.bars
    if bars.empty:
        return ChartOut(sym, res.freshness, [], [])
    close = bars["close"].astype(float)
    s50, s200 = sma(close, 50), sma(close, 200)
    start = state.market.clock().date() - timedelta(days=days)
    events = [e for e in [*crossovers(close), *big_moves(close)] if e.day >= start]
    events.sort(key=lambda e: e.day)

    def _f(x: float) -> float | None:
        return None if math.isnan(x) else round(float(x), 4)

    points: list[ChartPoint] = []
    for d, o, h, lo, c, a50, a200 in zip(
        bars.index, bars["open"], bars["high"], bars["low"], close, s50, s200, strict=True
    ):
        if d >= start:
            points.append(ChartPoint(d, float(o), float(h), float(lo), float(c), _f(a50), _f(a200)))
    return ChartOut(sym, res.freshness, points, events)


# --- learn -------------------------------------------------------------------------------------


@router.get("/learn", response_model=LearnContent)
def learn(_p: PrincipalDep) -> LearnContent:
    try:
        return load_learn()
    except ValueError as exc:
        raise HTTPException(500, f"content/learn.json is invalid: {exc}") from exc

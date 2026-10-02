"""Market data + system endpoints. Every number returned carries its source and timestamps."""

from __future__ import annotations

import json
from datetime import date, datetime, timedelta
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Path, Query
from pydantic import BaseModel
from sqlalchemy import select

from keystone_ledger import __version__
from keystone_ledger.api.deps import DbDep, PrincipalDep, StateDep
from keystone_ledger.data.base import SYMBOL_RE
from keystone_ledger.data.service import Freshness
from keystone_ledger.db.models import ConfigAudit

router = APIRouter(prefix="/api", tags=["market"])

SymbolPath = Annotated[str, Path(min_length=1, max_length=16, pattern=SYMBOL_RE.pattern)]


class FreshnessOut(BaseModel):
    source: str | None
    fetched_at: datetime | None
    last_day: date | None
    expected_day: date
    stale: bool
    reason: str
    last_error: str

    @classmethod
    def of(cls, f: Freshness) -> FreshnessOut:
        return cls(**f.__dict__)


class BarOut(BaseModel):
    day: date
    open: float
    high: float
    low: float
    close: float
    adj_close: float
    volume: float


class BarsOut(BaseModel):
    symbol: str
    freshness: FreshnessOut
    bars: list[BarOut]


class PointOut(BaseModel):
    day: date
    value: float


class SeriesOut(BaseModel):
    series_id: str
    freshness: FreshnessOut
    points: list[PointOut]


class HealthOut(BaseModel):
    status: str
    version: str


class ConfigAuditOut(BaseModel):
    at: datetime
    fingerprint: str
    diff: dict[str, Any]


class ConfigOut(BaseModel):
    fingerprint: str
    config: dict[str, Any]
    history: list[ConfigAuditOut]


@router.get("/health", response_model=HealthOut)
def health() -> HealthOut:
    return HealthOut(status="ok", version=__version__)


@router.get("/market/bars/{symbol}", response_model=BarsOut)
def bars(
    symbol: SymbolPath,
    state: StateDep,
    _p: PrincipalDep,
    days: Annotated[int, Query(ge=5, le=365 * 40)] = 400,
) -> BarsOut:
    start = state.market.clock().date() - timedelta(days=days)
    try:
        res = state.market.get_bars(symbol, start=start, refresh=False)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return BarsOut(
        symbol=res.symbol,
        freshness=FreshnessOut.of(res.freshness),
        bars=[
            BarOut(day=d, **{k: float(row[k]) for k in BarOut.model_fields if k != "day"})
            for d, row in res.bars.iterrows()
        ],
    )


@router.get("/market/series/{series_id}", response_model=SeriesOut)
def series(
    series_id: Annotated[str, Path(pattern=r"^[A-Za-z0-9_]{1,32}$")],
    state: StateDep,
    _p: PrincipalDep,
    days: Annotated[int, Query(ge=5, le=365 * 40)] = 400,
) -> SeriesOut:
    start = state.market.clock().date() - timedelta(days=days)
    res = state.market.get_series(series_id, start=start, refresh=False)
    return SeriesOut(
        series_id=res.series_id,
        freshness=FreshnessOut.of(res.freshness),
        points=[PointOut(day=d, value=float(v)) for d, v in res.values.items()],
    )


@router.get("/config", response_model=ConfigOut)
def get_config(state: StateDep, db: DbDep, _p: PrincipalDep) -> ConfigOut:
    rows = db.scalars(select(ConfigAudit).order_by(ConfigAudit.id.desc()).limit(50)).all()
    return ConfigOut(
        fingerprint=state.config.fingerprint(),
        config=state.config.model_dump(mode="json"),
        history=[
            ConfigAuditOut(at=r.at, fingerprint=r.fingerprint, diff=json.loads(r.diff_json))
            for r in rows
        ],
    )

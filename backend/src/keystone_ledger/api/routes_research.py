"""Search (the public research.json, cached) and the owner's watchlist."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Path, Response, status
from pydantic import BaseModel, ConfigDict
from sqlalchemy import func, select

from keystone_ledger.api.deps import CsrfPrincipalDep, DbDep, PrincipalDep, StateDep
from keystone_ledger.data.base import SYMBOL_RE
from keystone_ledger.data.research_feed import ResearchStatus
from keystone_ledger.db.models import SecurityEvent, WatchItem
from keystone_ledger.db.session import transaction
from keystone_ledger.planner import MAX_INCLUDED

router = APIRouter(prefix="/api", tags=["research"])

MAX_WATCH = 50
SymbolPath = Annotated[str, Path(min_length=1, max_length=16, pattern=SYMBOL_RE.pattern)]


@dataclass(frozen=True)
class ResearchOut:
    status: ResearchStatus
    data: dict[str, Any] | None


@router.get("/research", response_model=ResearchOut)
def research(state: StateDep, _p: PrincipalDep) -> ResearchOut:
    """Cache only: never downloads (use POST /research/refresh)."""
    return ResearchOut(state.research.status(), state.research.data())


@router.post("/research/refresh", response_model=ResearchOut)
def refresh_research(state: StateDep, _p: CsrfPrincipalDep) -> ResearchOut:
    """Download today's file if the copy is over 6 hours old (otherwise a no-op)."""
    if state.research.needs_refresh():
        state.research.refresh()
    return ResearchOut(state.research.status(), state.research.data())


@dataclass(frozen=True)
class WatchOut:
    symbol: str
    added_at: datetime
    added_price: float | None
    verdict_at_add: str
    include: bool


def _list(db: Any) -> list[WatchOut]:
    rows = db.scalars(select(WatchItem).order_by(WatchItem.added_at)).all()
    return [WatchOut(w.symbol, w.added_at, w.added_price, w.verdict_at_add, w.include)
            for w in rows]  # fmt: skip


@router.get("/watchlist", response_model=list[WatchOut])
def watchlist(db: DbDep, _p: PrincipalDep) -> list[WatchOut]:
    return _list(db)


class _Empty(BaseModel):
    model_config = ConfigDict(extra="forbid")


class IncludeIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    include: bool


def _event(db: Any, now: datetime, detail: str) -> None:
    db.add(SecurityEvent(at=now, kind="watchlist_updated", detail=detail[:200]))


@router.put("/watchlist/{symbol}", response_model=list[WatchOut])
def add(symbol: SymbolPath, _body: _Empty, state: StateDep, _p: CsrfPrincipalDep) -> list[WatchOut]:
    """Save a company from Search. Its price and verdict come from the search data, never from
    the request."""
    c = state.research.company(symbol)
    if c is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not in today's search data")
    now = state.market.clock()
    with transaction(state.session_factory) as s:
        if s.get(WatchItem, symbol) is None:
            if (s.scalar(select(func.count()).select_from(WatchItem)) or 0) >= MAX_WATCH:
                raise HTTPException(
                    status.HTTP_409_CONFLICT, f"the watchlist is full ({MAX_WATCH})"
                )
            close = c.get("close")
            s.add(WatchItem(symbol=symbol, added_at=now, verdict_at_add=str(c.get("v")),
                            added_price=float(close) if isinstance(close, (int, float)) else None,
                            include=False))  # fmt: skip
            _event(s, now, f"add {symbol}")
        return _list(s)


@router.patch("/watchlist/{symbol}", response_model=list[WatchOut])
def set_include(
    symbol: SymbolPath, body: IncludeIn, state: StateDep, _p: CsrfPrincipalDep
) -> list[WatchOut]:
    now = state.market.clock()
    with transaction(state.session_factory) as s:
        w = s.get(WatchItem, symbol)
        if w is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "not on the watchlist")
        if body.include and not w.include:
            c = state.research.company(symbol)
            if c is None or c.get("v") != "fit":
                raise HTTPException(
                    status.HTTP_409_CONFLICT, "only a current Good fit can be included"
                )
            count = s.scalar(select(func.count()).select_from(WatchItem).where(WatchItem.include))
            if (count or 0) >= MAX_INCLUDED:
                raise HTTPException(status.HTTP_409_CONFLICT, f"at most {MAX_INCLUDED} picks")
        w.include = body.include
        _event(s, now, f"include {symbol}={body.include}")
        return _list(s)


@router.delete("/watchlist/{symbol}", status_code=204)
def remove(symbol: SymbolPath, state: StateDep, _p: CsrfPrincipalDep) -> Response:
    with transaction(state.session_factory) as s:
        w = s.get(WatchItem, symbol)
        if w is not None:
            s.delete(w)
            _event(s, state.market.clock(), f"remove {symbol}")
    return Response(status_code=204)

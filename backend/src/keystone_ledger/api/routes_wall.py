"""The growing wall: log a monthly contribution, see the wall, remove a mistaken entry."""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, datetime
from typing import Annotated

from fastapi import APIRouter, HTTPException, Path, Query, Response, status
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import func, select

from keystone_ledger.api.deps import CsrfPrincipalDep, DbDep, PrincipalDep, StateDep
from keystone_ledger.core.wall import WallView, add_months, build_wall, month_start
from keystone_ledger.db.models import Contribution
from keystone_ledger.db.session import transaction

router = APIRouter(prefix="/api", tags=["wall"])

MONTH_RE = re.compile(r"^(19[9]\d|20\d\d)-(0[1-9]|1[0-2])$")
MAX_ENTRIES = 2000
EARLIEST = date(1990, 1, 1)


def parse_month(value: str) -> date:
    if not MONTH_RE.fullmatch(value):
        raise ValueError("month must look like 2026-10")
    y, m = value.split("-")
    return date(int(y), int(m), 1)


def resolve_this_month(server_today: date, client_month: str | None) -> date:
    """Use the browser's month (its local time zone) if it's within a month of the server's;
    otherwise fall back to the server's month."""
    server = month_start(server_today)
    if client_month:
        try:
            m = parse_month(client_month)
        except ValueError:
            return server
        if add_months(server, -1) <= m <= add_months(server, 1):
            return m
    return server


class ContributionIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    month: Annotated[str, Field(min_length=7, max_length=7)]
    amount: Annotated[float, Field(gt=0, le=10_000_000, allow_inf_nan=False)]
    note: Annotated[str, Field(max_length=120)] = ""
    this_month: Annotated[str | None, Field(min_length=7, max_length=7)] = None

    @field_validator("month")
    @classmethod
    def _month(cls, v: str) -> str:
        parse_month(v)
        return v

    @field_validator("note")
    @classmethod
    def _note(cls, v: str) -> str:
        return " ".join(v.split())  # collapse whitespace/newlines


@dataclass(frozen=True)
class EntryOut:
    id: int
    month: date
    amount: float
    note: str
    created_at: datetime


@dataclass(frozen=True)
class WallOut:
    wall: WallView
    entries: list[EntryOut]  # newest first, most recent 24


def _wall(state: StateDep, db: DbDep, this_month: str | None) -> WallOut:
    tm = resolve_this_month(state.market.clock().date(), this_month)
    rows = db.scalars(select(Contribution).order_by(Contribution.month, Contribution.id)).all()
    view = build_wall([(r.month, r.amount) for r in rows], tm)
    recent = sorted(rows, key=lambda r: (r.month, r.id), reverse=True)[:24]
    return WallOut(view, [EntryOut(r.id, r.month, r.amount, r.note, r.created_at) for r in recent])


ThisMonth = Annotated[str | None, Query(alias="this_month", min_length=7, max_length=7)]


@router.get("/wall", response_model=WallOut)
def get_wall(state: StateDep, db: DbDep, _p: PrincipalDep, this_month: ThisMonth = None) -> WallOut:
    return _wall(state, db, this_month)


@router.post("/contributions", response_model=WallOut, status_code=status.HTTP_201_CREATED)
def add_contribution(body: ContributionIn, state: StateDep, _p: CsrfPrincipalDep) -> WallOut:
    month = parse_month(body.month)
    tm = resolve_this_month(state.market.clock().date(), body.this_month)
    if month > tm:
        raise HTTPException(422, "That month hasn't happened yet. Log money after you invest it.")
    if month < EARLIEST:
        raise HTTPException(422, "Months before 1990 aren't supported.")
    with transaction(state.session_factory) as s:
        count = s.scalar(select(func.count()).select_from(Contribution)) or 0
        if count >= MAX_ENTRIES:
            raise HTTPException(422, f"The log is full ({MAX_ENTRIES} entries).")
        s.add(Contribution(month=month, amount=round(body.amount, 2), note=body.note,
                           created_at=state.market.clock()))  # fmt: skip
    with state.session_factory() as s:
        return _wall(state, s, body.this_month)


@router.delete("/contributions/{entry_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_contribution(
    entry_id: Annotated[int, Path(ge=1, le=2**31)], state: StateDep, _p: CsrfPrincipalDep
) -> Response:
    with transaction(state.session_factory) as s:
        row = s.get(Contribution, entry_id)
        if row is None:
            raise HTTPException(404, "entry not found")
        s.delete(row)
    return Response(status_code=status.HTTP_204_NO_CONTENT)

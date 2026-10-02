"""Shared FastAPI dependencies: app container, DB session, auth and CSRF enforcement."""

from __future__ import annotations

import hmac
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy.orm import Session, sessionmaker

from keystone_ledger.config import AppConfig
from keystone_ledger.core.auth import AuthService
from keystone_ledger.data.fundamentals import FundamentalsService
from keystone_ledger.data.service import MarketDataService
from keystone_ledger.db.models import AuthSession, User
from keystone_ledger.db.session import transaction
from keystone_ledger.planner import Planner
from keystone_ledger.settings import Settings

SESSION_COOKIE = "kl_session"
CSRF_HEADER = "x-csrf-token"


@dataclass
class AppState:
    settings: Settings
    config: AppConfig
    session_factory: sessionmaker[Session]
    auth: AuthService
    market: MarketDataService
    fundamentals: FundamentalsService
    planner: Planner


def get_state(request: Request) -> AppState:
    state: AppState = request.app.state.kl
    return state


StateDep = Annotated[AppState, Depends(get_state)]


def get_db(state: StateDep) -> Iterator[Session]:
    with state.session_factory() as s, s.begin():
        yield s


DbDep = Annotated[Session, Depends(get_db)]


@dataclass(frozen=True)
class Principal:
    user: User
    session: AuthSession


def current_principal(request: Request, state: StateDep) -> Principal:
    # Own short transaction: the last-seen touch is committed immediately, so the request's
    # session never holds SQLite's write lock while slow provider calls write elsewhere.
    with transaction(state.session_factory) as s:
        resolved = state.auth.resolve(s, request.cookies.get(SESSION_COOKIE))
    if resolved is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "not authenticated")
    return Principal(*resolved)


PrincipalDep = Annotated[Principal, Depends(current_principal)]


def csrf_protected(request: Request, principal: PrincipalDep) -> Principal:
    """Require the per-session CSRF token on every state-changing authenticated request."""
    presented = request.headers.get(CSRF_HEADER, "")
    if not presented or not hmac.compare_digest(
        presented.encode(), principal.session.csrf_token.encode()
    ):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "missing or invalid CSRF token")
    return principal


CsrfPrincipalDep = Annotated[Principal, Depends(csrf_protected)]

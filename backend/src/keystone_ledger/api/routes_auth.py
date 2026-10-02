"""Auth endpoints: first-run setup, login, logout, password change, status."""

from __future__ import annotations

import contextlib
import re
from typing import Annotated

from fastapi import APIRouter, HTTPException, Request, Response, status
from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from keystone_ledger.api.deps import (
    SESSION_COOKIE,
    CsrfPrincipalDep,
    DbDep,
    StateDep,
)
from keystone_ledger.core.auth import (
    MAX_PASSWORD_LEN,
    AuthError,
    IssuedSession,
    LockedOutError,
    check_setup_token,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])

USERNAME_RE = re.compile(r"^[A-Za-z0-9_.\-]{3,32}$")
Username = Annotated[str, StringConstraints(strip_whitespace=True, min_length=3, max_length=32)]
Password = Annotated[str, Field(min_length=1, max_length=MAX_PASSWORD_LEN)]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SetupIn(_Strict):
    setup_token: Annotated[str, Field(min_length=8, max_length=128)]
    username: Username
    password: Password


class LoginIn(_Strict):
    username: Annotated[str, Field(min_length=1, max_length=64)]
    password: Password


class PasswordChangeIn(_Strict):
    current_password: Password
    new_password: Password


class AuthStatusOut(BaseModel):
    setup_required: bool
    authenticated: bool
    username: str | None = None
    csrf_token: str | None = None


def _set_cookie(response: Response, issued: IssuedSession, secure: bool) -> None:
    response.set_cookie(
        SESSION_COOKIE,
        issued.token,
        httponly=True,
        secure=secure,
        samesite="strict",
        path="/",
        expires=issued.expires_at,
    )


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


@router.get("/status", response_model=AuthStatusOut)
def auth_status(request: Request, state: StateDep, db: DbDep) -> AuthStatusOut:
    if not state.auth.has_user(db):
        return AuthStatusOut(setup_required=True, authenticated=False)
    resolved = state.auth.resolve(db, request.cookies.get(SESSION_COOKIE))
    if resolved is None:
        return AuthStatusOut(setup_required=False, authenticated=False)
    user, sess = resolved
    return AuthStatusOut(
        setup_required=False,
        authenticated=True,
        username=user.username,
        csrf_token=sess.csrf_token,
    )


@router.post("/setup", response_model=AuthStatusOut, status_code=status.HTTP_201_CREATED)
def setup(
    body: SetupIn, request: Request, response: Response, state: StateDep, db: DbDep
) -> AuthStatusOut:
    if state.auth.has_user(db):
        raise HTTPException(status.HTTP_409_CONFLICT, "account already exists")
    if not USERNAME_RE.fullmatch(body.username):
        raise HTTPException(422, "username: 3-32 chars of letters, digits, _ . -")
    if not check_setup_token(state.settings.setup_token_path, body.setup_token):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "invalid setup token")
    try:
        state.auth.create_user(db, body.username, body.password)
        issued = state.auth.login(db, body.username, body.password, _client_ip(request))
    except AuthError as exc:
        raise HTTPException(422, str(exc)) from exc
    with contextlib.suppress(FileNotFoundError):
        state.settings.setup_token_path.unlink()
    _set_cookie(response, issued, state.settings.https)
    return AuthStatusOut(
        setup_required=False,
        authenticated=True,
        username=body.username,
        csrf_token=issued.csrf_token,
    )


@router.post("/login", response_model=AuthStatusOut)
def login(body: LoginIn, request: Request, response: Response, state: StateDep) -> AuthStatusOut:
    # Explicit transaction: failed attempts must be committed even though we return an error.
    with state.session_factory() as db:
        try:
            issued = state.auth.login(db, body.username, body.password, _client_ip(request))
        except LockedOutError as exc:
            db.commit()
            raise HTTPException(
                status.HTTP_429_TOO_MANY_REQUESTS,
                str(exc),
                headers={"Retry-After": str(exc.retry_after_s)},
            ) from exc
        except AuthError as exc:
            db.commit()
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, str(exc)) from exc
        db.commit()
    _set_cookie(response, issued, state.settings.https)
    return AuthStatusOut(
        setup_required=False,
        authenticated=True,
        username=body.username.strip(),
        csrf_token=issued.csrf_token,
    )


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(request: Request, principal: CsrfPrincipalDep, state: StateDep, db: DbDep) -> Response:
    state.auth.logout(db, request.cookies.get(SESSION_COOKIE))
    response = Response(status_code=status.HTTP_204_NO_CONTENT)
    response.delete_cookie(SESSION_COOKIE, path="/", samesite="strict", httponly=True)
    return response


@router.post("/password", response_model=AuthStatusOut)
def change_password(
    body: PasswordChangeIn,
    response: Response,
    principal: CsrfPrincipalDep,
    state: StateDep,
    db: DbDep,
) -> AuthStatusOut:
    try:
        issued = state.auth.change_password(
            db, principal.user, body.current_password, body.new_password
        )
    except AuthError as exc:
        raise HTTPException(422, str(exc)) from exc
    _set_cookie(response, issued, state.settings.https)
    return AuthStatusOut(
        setup_required=False,
        authenticated=True,
        username=principal.user.username,
        csrf_token=issued.csrf_token,
    )

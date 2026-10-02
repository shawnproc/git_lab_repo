from __future__ import annotations

import os
import stat
from datetime import timedelta
from pathlib import Path

import pytest
from sqlalchemy import select

from keystone_ledger.core.auth import (
    AuthError,
    AuthPolicy,
    AuthService,
    LockedOutError,
    check_setup_token,
    ensure_setup_token,
    hash_password,
    hash_token,
    password_problems,
    verify_password,
)
from keystone_ledger.db.models import AuthSession
from keystone_ledger.db.session import init_schema, make_engine, make_session_factory, transaction

from .conftest import PASSWORD, FakeClock

POLICY = AuthPolicy(
    idle=timedelta(hours=12),
    absolute=timedelta(days=7),
    max_failures=5,
    window=timedelta(minutes=15),
    lockout=timedelta(minutes=15),
)


@pytest.fixture
def svc(clock: FakeClock) -> AuthService:
    return AuthService(POLICY, clock)


@pytest.fixture
def sf():  # type: ignore[no-untyped-def]
    engine = make_engine(None)
    init_schema(engine)
    return make_session_factory(engine)


@pytest.fixture
def user(svc: AuthService, sf) -> None:  # type: ignore[no-untyped-def]
    with transaction(sf) as s:
        svc.create_user(s, "shawn", PASSWORD)


def test_argon2id_hash() -> None:
    h = hash_password(PASSWORD)
    assert h.startswith("$argon2id$")
    assert verify_password(h, PASSWORD)
    assert not verify_password(h, PASSWORD + "x")
    assert not verify_password("not-a-hash", PASSWORD)


def test_password_policy() -> None:
    assert password_problems("shawn", "short")
    assert password_problems("shawn", "shawn-is-my-password")
    assert password_problems("x", "aaaaaaaaaaaaaaaa")
    assert password_problems("x", "a" * 300 + "bcdefg")
    assert password_problems("shawn", PASSWORD) == []


def test_single_account_only(svc: AuthService, sf, user) -> None:  # type: ignore[no-untyped-def]
    with transaction(sf) as s, pytest.raises(AuthError):
        svc.create_user(s, "other", PASSWORD)


def test_session_token_stored_hashed(svc: AuthService, sf, user) -> None:  # type: ignore[no-untyped-def]
    with transaction(sf) as s:
        issued = svc.login(s, "shawn", PASSWORD, "127.0.0.1")
    with sf() as s:
        rows = s.scalars(select(AuthSession)).all()
    assert [r.token_hash for r in rows] == [hash_token(issued.token)]
    assert all(issued.token not in r.token_hash for r in rows)


def test_idle_timeout(svc: AuthService, sf, user, clock: FakeClock) -> None:  # type: ignore[no-untyped-def]
    with transaction(sf) as s:
        issued = svc.login(s, "shawn", PASSWORD, "127.0.0.1")
    clock.advance(hours=11, minutes=59)
    with transaction(sf) as s:
        assert svc.resolve(s, issued.token) is not None  # touch -> resets idle timer
    clock.advance(hours=11, minutes=59)
    with transaction(sf) as s:
        assert svc.resolve(s, issued.token) is not None
    clock.advance(hours=12)
    with transaction(sf) as s:
        assert svc.resolve(s, issued.token) is None


def test_absolute_timeout(svc: AuthService, sf, user, clock: FakeClock) -> None:  # type: ignore[no-untyped-def]
    with transaction(sf) as s:
        issued = svc.login(s, "shawn", PASSWORD, "127.0.0.1")
    for _ in range(16):  # keep it active, 11h at a time, past 7 days (176h)
        clock.advance(hours=11)
        with transaction(sf) as s:
            alive = svc.resolve(s, issued.token) is not None
    assert not alive


def test_lockout_after_failures(svc: AuthService, sf, user, clock: FakeClock) -> None:  # type: ignore[no-untyped-def]
    for i in range(5):
        with transaction(sf) as s:
            exc_type = LockedOutError if i == 4 else AuthError
            with pytest.raises(exc_type):
                svc.login(s, "shawn", "wrong password!!", "127.0.0.1")
    # Correct password is refused while locked out.
    with transaction(sf) as s, pytest.raises(LockedOutError) as ei:
        svc.login(s, "shawn", PASSWORD, "127.0.0.1")
    assert 0 < ei.value.retry_after_s <= 15 * 60
    clock.advance(minutes=16)
    with transaction(sf) as s:
        assert svc.login(s, "shawn", PASSWORD, "127.0.0.1").token


def test_unknown_user_same_error(svc: AuthService, sf, user) -> None:  # type: ignore[no-untyped-def]
    with transaction(sf) as s, pytest.raises(AuthError, match="invalid username or password"):
        svc.login(s, "nobody", PASSWORD, "127.0.0.1")


def test_change_password_revokes_sessions(svc: AuthService, sf, user) -> None:  # type: ignore[no-untyped-def]
    with transaction(sf) as s:
        old = svc.login(s, "shawn", PASSWORD, "127.0.0.1")
    with transaction(sf) as s:
        u, _ = svc.resolve(s, old.token)  # type: ignore[misc]
        new = svc.change_password(s, u, PASSWORD, "an even longer passphrase 42")
    with transaction(sf) as s:
        assert svc.resolve(s, old.token) is None
        assert svc.resolve(s, new.token) is not None


def test_setup_token_file_is_private(tmp_path: Path) -> None:
    p = tmp_path / "sub" / "setup-token.txt"
    tok = ensure_setup_token(p)
    assert ensure_setup_token(p) == tok
    assert stat.S_IMODE(os.stat(p).st_mode) == 0o600
    assert check_setup_token(p, tok)
    assert not check_setup_token(p, tok + "x")
    assert not check_setup_token(tmp_path / "nope", tok)


def test_database_file_is_owner_only(tmp_path: Path) -> None:
    db = tmp_path / "var" / "k.sqlite3"
    init_schema(make_engine(db))
    assert stat.S_IMODE(os.stat(db).st_mode) == 0o600
    db.chmod(0o644)
    make_engine(db)
    assert stat.S_IMODE(os.stat(db).st_mode) == 0o600

"""Single-user authentication: argon2id hashing, server-side sessions, login lockout.

Threat model (local, single-user app):
* Another local process or a malicious web page in the user's browser is the realistic attacker.
  Browser-borne attacks are handled by SameSite=Strict cookies, CSRF tokens, Origin checks and
  Host-header validation (DNS rebinding) in `api/security.py`.
* First-run setup is gated by a one-time token printed to the console and written to a 0600 file,
  so the first process/page to reach the port cannot claim the account.
* Session tokens are 256-bit random values; only their SHA-256 is stored.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import secrets
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from keystone_ledger.db.models import AuthSession, LoginAttempt, SecurityEvent, User

Clock = Callable[[], datetime]

MIN_PASSWORD_LEN = 12
MAX_PASSWORD_LEN = 256  # bounds argon2 work per request

# argon2id with RFC 9106 "low memory" profile (argon2-cffi default type is ID).
_hasher = PasswordHasher(time_cost=3, memory_cost=64 * 1024, parallelism=4)
# Verified against when the username is unknown, so timing doesn't reveal valid usernames.
_DUMMY_HASH = _hasher.hash(secrets.token_urlsafe(16))


def utcnow() -> datetime:
    return datetime.now(UTC)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(stored_hash: str, password: str) -> bool:
    try:
        return _hasher.verify(stored_hash, password)
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def password_problems(username: str, password: str) -> list[str]:
    problems: list[str] = []
    if len(password) < MIN_PASSWORD_LEN:
        problems.append(f"must be at least {MIN_PASSWORD_LEN} characters")
    if len(password) > MAX_PASSWORD_LEN:
        problems.append(f"must be at most {MAX_PASSWORD_LEN} characters")
    if username.lower() in password.lower():
        problems.append("must not contain the username")
    if len(set(password)) < 6:
        problems.append("is too repetitive")
    return problems


class AuthError(Exception):
    """Generic auth failure. Message is safe to show the client."""


class LockedOutError(AuthError):
    def __init__(self, retry_after_s: int) -> None:
        super().__init__("too many failed attempts; try again later")
        self.retry_after_s = retry_after_s


# --- setup token ------------------------------------------------------------------------------


def ensure_setup_token(path: Path) -> str:
    """Create (or reuse) the one-time setup token. File is created 0600, never world-readable."""
    if path.exists():
        return path.read_text().strip()
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    token = secrets.token_urlsafe(24)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write(token + "\n")
    return token


def check_setup_token(path: Path, presented: str) -> bool:
    if not path.exists():
        return False
    expected = path.read_text().strip()
    return bool(expected) and hmac.compare_digest(expected.encode(), presented.encode())


# --- service ----------------------------------------------------------------------------------


@dataclass(frozen=True)
class AuthPolicy:
    idle: timedelta
    absolute: timedelta
    max_failures: int
    window: timedelta
    lockout: timedelta


@dataclass(frozen=True)
class IssuedSession:
    token: str
    csrf_token: str
    expires_at: datetime


class AuthService:
    def __init__(self, policy: AuthPolicy, clock: Clock = utcnow) -> None:
        self.policy = policy
        self.clock = clock

    # setup ------------------------------------------------------------------------------------

    @staticmethod
    def has_user(s: Session) -> bool:
        return (s.scalar(select(func.count()).select_from(User)) or 0) > 0

    def create_user(self, s: Session, username: str, password: str) -> User:
        if self.has_user(s):
            raise AuthError("account already exists")
        problems = password_problems(username, password)
        if problems:
            raise AuthError("password " + "; ".join(problems))
        now = self.clock()
        user = User(
            username=username,
            password_hash=hash_password(password),
            created_at=now,
            password_changed_at=now,
        )
        s.add(user)
        s.add(SecurityEvent(at=now, kind="account_created", detail=f"username={username}"))
        s.flush()
        return user

    # login ------------------------------------------------------------------------------------

    def _lockout_remaining(self, s: Session, username: str) -> int:
        """Seconds of lockout remaining, based on recent consecutive failures (persisted)."""
        now = self.clock()
        since = now - self.policy.window
        recent = s.scalars(
            select(LoginAttempt)
            .where(LoginAttempt.username == username, LoginAttempt.at >= since)
            .order_by(LoginAttempt.at.desc(), LoginAttempt.id.desc())
        ).all()
        failures: list[LoginAttempt] = []
        for attempt in recent:
            if attempt.success:
                break
            failures.append(attempt)
        if len(failures) < self.policy.max_failures:
            return 0
        unlock_at = failures[0].at + self.policy.lockout
        return max(0, int((unlock_at - now).total_seconds()))

    def login(self, s: Session, username: str, password: str, client_ip: str) -> IssuedSession:
        username = username.strip()
        remaining = self._lockout_remaining(s, username)
        if remaining > 0:
            raise LockedOutError(remaining)

        user = s.scalar(select(User).where(User.username == username))
        ok = verify_password(user.password_hash if user else _DUMMY_HASH, password)
        ok = ok and user is not None
        now = self.clock()
        s.add(LoginAttempt(username=username, client_ip=client_ip, at=now, success=ok))
        if not ok or user is None:
            s.add(SecurityEvent(at=now, kind="login_failed", detail=f"ip={client_ip}"))
            s.flush()
            remaining = self._lockout_remaining(s, username)
            if remaining > 0:
                s.add(SecurityEvent(at=now, kind="lockout", detail=f"ip={client_ip}"))
                raise LockedOutError(remaining)
            raise AuthError("invalid username or password")

        if _hasher.check_needs_rehash(user.password_hash):
            user.password_hash = hash_password(password)
        s.add(SecurityEvent(at=now, kind="login_ok", detail=f"ip={client_ip}"))
        return self._issue(s, user)

    def _issue(self, s: Session, user: User) -> IssuedSession:
        now = self.clock()
        token = secrets.token_urlsafe(32)
        csrf = secrets.token_urlsafe(32)
        expires = now + self.policy.absolute
        s.add(
            AuthSession(
                token_hash=hash_token(token),
                user_id=user.id,
                csrf_token=csrf,
                created_at=now,
                last_seen_at=now,
                expires_at=expires,
            )
        )
        # Opportunistic cleanup of dead sessions and old attempts.
        s.execute(delete(AuthSession).where(AuthSession.expires_at < now))
        s.execute(delete(LoginAttempt).where(LoginAttempt.at < now - timedelta(days=30)))
        return IssuedSession(token=token, csrf_token=csrf, expires_at=expires)

    # session validation -----------------------------------------------------------------------

    def resolve(self, s: Session, token: str | None) -> tuple[User, AuthSession] | None:
        if not token or len(token) > 128:
            return None
        sess = s.get(AuthSession, hash_token(token))
        if sess is None:
            return None
        now = self.clock()
        if now >= sess.expires_at or now - sess.last_seen_at >= self.policy.idle:
            s.delete(sess)
            return None
        user = s.get(User, sess.user_id)
        if user is None:
            return None
        sess.last_seen_at = now
        return user, sess

    def logout(self, s: Session, token: str | None) -> None:
        if token:
            s.execute(delete(AuthSession).where(AuthSession.token_hash == hash_token(token)))

    def change_password(self, s: Session, user: User, current: str, new: str) -> IssuedSession:
        if not verify_password(user.password_hash, current):
            raise AuthError("current password is incorrect")
        problems = password_problems(user.username, new)
        if problems:
            raise AuthError("password " + "; ".join(problems))
        now = self.clock()
        user.password_hash = hash_password(new)
        user.password_changed_at = now
        # Invalidate every existing session, then issue a fresh one.
        s.execute(delete(AuthSession).where(AuthSession.user_id == user.id))
        s.add(SecurityEvent(at=now, kind="password_changed", detail=""))
        return self._issue(s, user)

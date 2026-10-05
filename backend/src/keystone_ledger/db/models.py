"""SQLite schema. All access goes through the SQLAlchemy ORM / Core (parameterized queries only)."""

from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import (
    Date,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from keystone_ledger.db.types import UTCDateTime

SCHEMA_VERSION = 4


class Base(DeclarativeBase):
    pass


class SchemaMeta(Base):
    __tablename__ = "schema_meta"
    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[str] = mapped_column(String(256))


# --- auth -------------------------------------------------------------------------------------


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True)
    password_hash: Mapped[str] = mapped_column(String(256))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime())
    password_changed_at: Mapped[datetime] = mapped_column(UTCDateTime())


class AuthSession(Base):
    """Server-side session. Only a SHA-256 of the cookie token is stored, never the token itself."""

    __tablename__ = "auth_sessions"
    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    csrf_token: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime())
    last_seen_at: Mapped[datetime] = mapped_column(UTCDateTime())
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime())


class LoginAttempt(Base):
    __tablename__ = "login_attempts"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    username: Mapped[str] = mapped_column(String(64))
    client_ip: Mapped[str] = mapped_column(String(64))
    at: Mapped[datetime] = mapped_column(UTCDateTime())
    success: Mapped[bool] = mapped_column()

    __table_args__ = (Index("ix_login_attempts_at", "at"),)


# --- audit ------------------------------------------------------------------------------------


class ConfigAudit(Base):
    __tablename__ = "config_audit"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    at: Mapped[datetime] = mapped_column(UTCDateTime())
    fingerprint: Mapped[str] = mapped_column(String(64))
    source: Mapped[str] = mapped_column(String(32))  # "startup"
    config_json: Mapped[str] = mapped_column(Text)
    diff_json: Mapped[str] = mapped_column(Text)


class SecurityEvent(Base):
    __tablename__ = "security_events"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    at: Mapped[datetime] = mapped_column(UTCDateTime())
    kind: Mapped[str] = mapped_column(String(64))
    detail: Mapped[str] = mapped_column(Text, default="")


# --- market data cache ------------------------------------------------------------------------


class PriceBar(Base):
    __tablename__ = "price_bars"
    symbol: Mapped[str] = mapped_column(String(16), primary_key=True)
    day: Mapped[date] = mapped_column(Date, primary_key=True)
    open: Mapped[float] = mapped_column(Float)
    high: Mapped[float] = mapped_column(Float)
    low: Mapped[float] = mapped_column(Float)
    close: Mapped[float] = mapped_column(Float)
    adj_close: Mapped[float] = mapped_column(Float)
    volume: Mapped[float] = mapped_column(Float)
    source: Mapped[str] = mapped_column(String(32))
    fetched_at: Mapped[datetime] = mapped_column(UTCDateTime())


class MacroObservation(Base):
    __tablename__ = "macro_observations"
    series_id: Mapped[str] = mapped_column(String(32), primary_key=True)
    day: Mapped[date] = mapped_column(Date, primary_key=True)
    value: Mapped[float] = mapped_column(Float)
    source: Mapped[str] = mapped_column(String(32))
    fetched_at: Mapped[datetime] = mapped_column(UTCDateTime())


class FetchLog(Base):
    """One row per provider call: what we asked for, what we got, and whether it failed."""

    __tablename__ = "fetch_log"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    dataset: Mapped[str] = mapped_column(String(16))  # "prices" | "macro"
    key: Mapped[str] = mapped_column(String(32))  # symbol or series id
    provider: Mapped[str] = mapped_column(String(32))
    started_at: Mapped[datetime] = mapped_column(UTCDateTime())
    ok: Mapped[bool] = mapped_column()
    rows: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str] = mapped_column(Text, default="")

    __table_args__ = (Index("ix_fetch_log_key", "dataset", "key", "started_at"),)


# --- portfolio --------------------------------------------------------------------------------


class Holding(Base):
    """What the owner actually holds, as entered by hand."""

    __tablename__ = "holdings"
    symbol: Mapped[str] = mapped_column(String(16), primary_key=True)
    shares: Mapped[float] = mapped_column(Float)
    avg_cost: Mapped[float] = mapped_column(Float)  # per share, USD
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime())


# --- fundamentals (SEC EDGAR) -----------------------------------------------------------------


class SecTicker(Base):
    __tablename__ = "sec_tickers"
    ticker: Mapped[str] = mapped_column(String(16), primary_key=True)
    cik: Mapped[int] = mapped_column(Integer, index=True)
    title: Mapped[str] = mapped_column(String(256))
    fetched_at: Mapped[datetime] = mapped_column(UTCDateTime())


class FundamentalFact(Base):
    """One XBRL value for one company, tag and calendar frame (e.g. Revenues, CY2024)."""

    __tablename__ = "fundamental_facts"
    cik: Mapped[int] = mapped_column(Integer, primary_key=True)
    tag: Mapped[str] = mapped_column(String(128), primary_key=True)
    period: Mapped[str] = mapped_column(String(16), primary_key=True)  # CY2024 / CY2024Q4I
    value: Mapped[float] = mapped_column(Float)
    end: Mapped[date] = mapped_column(Date)
    accn: Mapped[str] = mapped_column(String(32))
    source: Mapped[str] = mapped_column(String(32))
    fetched_at: Mapped[datetime] = mapped_column(UTCDateTime())


# --- the growing wall (contribution log) ------------------------------------------------------


class Contribution(Base):
    """Money the owner says they invested in a month. Entered by hand; never fetched."""

    __tablename__ = "contributions"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    month: Mapped[date] = mapped_column(Date, index=True)  # always the 1st of the month
    amount: Mapped[float] = mapped_column(Float)
    note: Mapped[str] = mapped_column(String(120), default="")
    created_at: Mapped[datetime] = mapped_column(UTCDateTime())


# --- watchlist (Search) -----------------------------------------------------------------------


class WatchItem(Base):
    """A company the owner saved from Search. The price and verdict are copied from the search
    data at the moment it was saved (never typed in), so later changes can be shown."""

    __tablename__ = "watchlist"
    symbol: Mapped[str] = mapped_column(String(16), primary_key=True)
    added_at: Mapped[datetime] = mapped_column(UTCDateTime())
    added_price: Mapped[float | None] = mapped_column(Float, nullable=True)
    verdict_at_add: Mapped[str] = mapped_column(String(16))
    include: Mapped[bool] = mapped_column(default=False)  # in buy days while still a Good fit

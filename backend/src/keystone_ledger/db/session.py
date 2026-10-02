"""Engine / session factory and schema bootstrap."""

from __future__ import annotations

import os
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from sqlalchemy import Engine, create_engine, event, select
from sqlalchemy.orm import Session, sessionmaker

from keystone_ledger.db.models import SCHEMA_VERSION, Base, SchemaMeta


def make_engine(db_path: Path | None) -> Engine:
    """Create a SQLite engine. `None` gives an in-memory DB (tests)."""
    if db_path is None:
        from sqlalchemy.pool import StaticPool

        engine = create_engine(
            "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
        )
    else:
        db_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if not db_path.exists():
            os.close(os.open(db_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600))
        # Holds the password hash and sessions: owner-only, also repairing older installs.
        for p in (db_path, *db_path.parent.glob(f"{db_path.name}-*")):
            p.chmod(0o600)
        engine = create_engine(
            f"sqlite:///{db_path}", connect_args={"check_same_thread": False, "timeout": 30}
        )

    @event.listens_for(engine, "connect")
    def _pragmas(dbapi_conn: Any, _rec: Any) -> None:
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA foreign_keys=ON")
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA synchronous=NORMAL")
        cur.close()

    return engine


def init_schema(engine: Engine) -> None:
    Base.metadata.create_all(engine)
    with Session(engine) as s, s.begin():
        row = s.scalar(select(SchemaMeta).where(SchemaMeta.key == "schema_version"))
        if row is None:
            s.add(SchemaMeta(key="schema_version", value=str(SCHEMA_VERSION)))
        elif int(row.value) > SCHEMA_VERSION:
            raise RuntimeError(
                f"database schema v{row.value} is newer than this app (v{SCHEMA_VERSION})"
            )


def make_session_factory(engine: Engine) -> sessionmaker[Session]:
    return sessionmaker(engine, expire_on_commit=False)


@contextmanager
def transaction(factory: sessionmaker[Session]) -> Iterator[Session]:
    with factory() as s, s.begin():
        yield s

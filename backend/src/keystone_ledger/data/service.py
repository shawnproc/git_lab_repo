"""Cache-first market data access with explicit freshness metadata.

Every result carries: source, fetched_at, last data date, the session we expected data for, and a
`stale` flag with a human-readable reason. The UI must surface `stale` loudly; nothing here ever
fills gaps or guesses values.

Refresh policy (per symbol / series):
* Nothing cached          -> fetch full history (`data.history_years`).
* Cached but behind       -> re-fetch from `last_day - OVERLAP_DAYS` (catches late revisions).
* Recent fetch already ran -> don't call the provider again for `RECHECK_MINUTES` even if behind
  (the provider may simply not have published yet); failures back off for `FAILURE_BACKOFF`.
* Dividend/split detected in the overlap (adj_close ratio moved) -> re-fetch full history, since
  every historical adj_close changes.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date, datetime, timedelta

import pandas as pd
from sqlalchemy import delete, select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session, sessionmaker

from keystone_ledger.core.auth import Clock, utcnow
from keystone_ledger.data.base import (
    BAR_COLUMNS,
    MacroProvider,
    PriceProvider,
    ProviderError,
    validate_bars,
    validate_series,
    validate_series_id,
    validate_symbol,
)
from keystone_ledger.data.calendar import MarketCalendar
from keystone_ledger.db.models import FetchLog, MacroObservation, PriceBar

log = logging.getLogger(__name__)

OVERLAP_DAYS = 10
RECHECK_MINUTES = 30
FAILURE_BACKOFF = timedelta(minutes=15)
ADJ_RATIO_TOLERANCE = 1e-4
# FRED publishes most daily series with roughly one session of lag.
MACRO_ALLOWED_LAG_SESSIONS = 1


@dataclass(frozen=True)
class Freshness:
    source: str | None
    fetched_at: datetime | None
    last_day: date | None
    expected_day: date
    stale: bool
    reason: str = ""
    last_error: str = ""


@dataclass(frozen=True)
class BarsResult:
    symbol: str
    bars: pd.DataFrame
    freshness: Freshness


@dataclass(frozen=True)
class SeriesResult:
    series_id: str
    values: pd.Series
    freshness: Freshness


@dataclass
class _FetchState:
    last_ok: datetime | None = None
    last_fail: datetime | None = None
    last_error: str = ""

    @property
    def failing(self) -> bool:
        """The most recent attempt failed."""
        return self.last_fail is not None and (
            self.last_ok is None or self.last_fail > self.last_ok
        )


class MarketDataService:
    def __init__(
        self,
        session_factory: sessionmaker[Session],
        prices: PriceProvider,
        macro: MacroProvider,
        calendar: MarketCalendar,
        history_years: int,
        clock: Clock = utcnow,
    ) -> None:
        self._sf = session_factory
        self.prices = prices
        self.macro = macro
        self.calendar = calendar
        self.history_years = history_years
        self.clock = clock

    # --- helpers ------------------------------------------------------------------------------

    def _fetch_state(self, s: Session, dataset: str, key: str) -> _FetchState:
        rows = s.scalars(
            select(FetchLog)
            .where(FetchLog.dataset == dataset, FetchLog.key == key)
            .order_by(FetchLog.started_at.desc(), FetchLog.id.desc())
            .limit(20)
        ).all()
        st = _FetchState()
        for r in rows:
            if r.ok and st.last_ok is None:
                st.last_ok = r.started_at
            if not r.ok and st.last_fail is None:
                st.last_fail, st.last_error = r.started_at, r.error
        return st

    def _should_fetch(self, st: _FetchState, behind: bool, have_any: bool) -> bool:
        now = self.clock()
        if st.failing and st.last_fail and now - st.last_fail < FAILURE_BACKOFF:
            return False
        if not have_any:
            return True
        if not behind:
            return False
        return st.last_ok is None or now - st.last_ok >= timedelta(minutes=RECHECK_MINUTES)

    def _history_start(self) -> date:
        today = self.clock().date()
        return today.replace(year=today.year - self.history_years)

    # --- prices -------------------------------------------------------------------------------

    def _load_bars(self, s: Session, symbol: str, start: date | None) -> pd.DataFrame:
        q = select(PriceBar).where(PriceBar.symbol == symbol)
        if start is not None:
            q = q.where(PriceBar.day >= start)
        rows = s.scalars(q.order_by(PriceBar.day)).all()
        if not rows:
            return pd.DataFrame(columns=[*BAR_COLUMNS, "source", "fetched_at"])
        return pd.DataFrame(
            {
                **{c: [getattr(r, c) for r in rows] for c in BAR_COLUMNS},
                "source": [r.source for r in rows],
                "fetched_at": [r.fetched_at for r in rows],
            },
            index=pd.Index([r.day for r in rows], name="day"),
        )

    def _upsert_bars(self, s: Session, symbol: str, df: pd.DataFrame, fetched: datetime) -> None:
        if df.empty:
            return
        records = [
            {
                "symbol": symbol,
                "day": day,
                **{c: float(row[c]) for c in BAR_COLUMNS},
                "source": self.prices.name,
                "fetched_at": fetched,
            }
            for day, row in df.iterrows()
        ]
        stmt = sqlite_insert(PriceBar)
        stmt = stmt.on_conflict_do_update(
            index_elements=[PriceBar.symbol, PriceBar.day],
            set_={c: stmt.excluded[c] for c in (*BAR_COLUMNS, "source", "fetched_at")},
        )
        for i in range(0, len(records), 500):
            s.execute(stmt, records[i : i + 500])

    @staticmethod
    def _adjustment_changed(cached: pd.DataFrame, fresh: pd.DataFrame) -> bool:
        common = cached.index.intersection(fresh.index)
        if len(common) == 0:
            return False
        old = cached.loc[common, "adj_close"].astype(float) / cached.loc[common, "close"]
        new = fresh.loc[common, "adj_close"].astype(float) / fresh.loc[common, "close"]
        old_close = cached.loc[common, "close"].astype(float)
        new_close = fresh.loc[common, "close"].astype(float)
        ratio_moved = ((old - new).abs() > ADJ_RATIO_TOLERANCE).any()
        split = ((old_close / new_close - 1).abs() > 0.02).any()
        return bool(ratio_moved or split)

    def refresh_bars(self, symbol: str) -> None:
        sym = validate_symbol(symbol)
        expected = self.calendar.last_completed_session(self.clock())
        with self._sf() as s, s.begin():
            st = self._fetch_state(s, "prices", sym)
            cached = self._load_bars(s, sym, None)
            last_day = cached.index.max() if not cached.empty else None
            behind = last_day is None or last_day < expected
            if not self._should_fetch(st, behind, not cached.empty):
                return
            start = (
                self._history_start() if last_day is None else last_day - timedelta(OVERLAP_DAYS)
            )
            self._fetch_and_store(s, sym, start, expected, cached)

    def _fetch_and_store(
        self, s: Session, sym: str, start: date, end: date, cached: pd.DataFrame
    ) -> None:
        started = self.clock()
        try:
            raw = self.prices.fetch_daily_bars(sym, start, end)
            df, report = validate_bars(raw)
            replace_all = not cached.empty and self._adjustment_changed(cached, df)
            if replace_all:
                log.info("prices: %s adjustment changed; refetching full history", sym)
                raw = self.prices.fetch_daily_bars(sym, self._history_start(), end)
                df, report = validate_bars(raw)
        except (ProviderError, ValueError) as exc:
            s.add(
                FetchLog(
                    dataset="prices",
                    key=sym,
                    provider=self.prices.name,
                    started_at=started,
                    ok=False,
                    rows=0,
                    error=str(exc)[:500],
                )
            )
            log.warning("prices: %s fetch failed: %s", sym, exc)
            return
        if replace_all and not df.empty:
            # Every historical adj_close moved; drop old rows so the series stays consistent.
            s.execute(delete(PriceBar).where(PriceBar.symbol == sym))
        self._upsert_bars(s, sym, df, started)
        note = f"dropped={report.dropped}" if report.dropped else ""
        s.add(
            FetchLog(
                dataset="prices",
                key=sym,
                provider=self.prices.name,
                started_at=started,
                ok=True,
                rows=len(df),
                error=note,
            )
        )

    def get_bars(self, symbol: str, start: date | None = None, refresh: bool = True) -> BarsResult:
        sym = validate_symbol(symbol)
        if refresh:
            self.refresh_bars(sym)
        expected = self.calendar.last_completed_session(self.clock())
        with self._sf() as s:
            df = self._load_bars(s, sym, start)
            st = self._fetch_state(s, "prices", sym)
        return BarsResult(sym, df, self._freshness(df, expected, st, allowed_lag=0))

    # --- macro --------------------------------------------------------------------------------

    def refresh_series(self, series_id: str) -> None:
        sid = validate_series_id(series_id)
        now = self.clock()
        expected = self.calendar.last_completed_session(now)
        with self._sf() as s, s.begin():
            st = self._fetch_state(s, "macro", sid)
            last_day = s.scalar(
                select(MacroObservation.day)
                .where(MacroObservation.series_id == sid)
                .order_by(MacroObservation.day.desc())
                .limit(1)
            )
            behind = last_day is None or last_day < expected
            if not self._should_fetch(st, behind, last_day is not None):
                return
            start = (
                self._history_start() if last_day is None else last_day - timedelta(OVERLAP_DAYS)
            )
            try:
                values, report = validate_series(self.macro.fetch_series(sid, start, now.date()))
            except (ProviderError, ValueError) as exc:
                s.add(
                    FetchLog(
                        dataset="macro",
                        key=sid,
                        provider=self.macro.name,
                        started_at=now,
                        ok=False,
                        error=str(exc)[:500],
                    )
                )
                log.warning("macro: %s fetch failed: %s", sid, exc)
                return
            if len(values):
                stmt = sqlite_insert(MacroObservation)
                stmt = stmt.on_conflict_do_update(
                    index_elements=[MacroObservation.series_id, MacroObservation.day],
                    set_={c: stmt.excluded[c] for c in ("value", "source", "fetched_at")},
                )
                s.execute(
                    stmt,
                    [
                        {
                            "series_id": sid,
                            "day": d,
                            "value": float(v),
                            "source": self.macro.name,
                            "fetched_at": now,
                        }
                        for d, v in values.items()
                    ],
                )
            note = f"dropped={report.dropped}" if report.dropped else ""
            s.add(
                FetchLog(
                    dataset="macro",
                    key=sid,
                    provider=self.macro.name,
                    started_at=now,
                    ok=True,
                    rows=len(values),
                    error=note,
                )
            )

    def get_series(
        self, series_id: str, start: date | None = None, refresh: bool = True
    ) -> SeriesResult:
        sid = validate_series_id(series_id)
        if refresh:
            self.refresh_series(sid)
        expected = self.calendar.last_completed_session(self.clock())
        with self._sf() as s:
            q = select(MacroObservation).where(MacroObservation.series_id == sid)
            if start is not None:
                q = q.where(MacroObservation.day >= start)
            rows = s.scalars(q.order_by(MacroObservation.day)).all()
            st = self._fetch_state(s, "macro", sid)
        frame = pd.DataFrame(
            {
                "value": [r.value for r in rows],
                "source": [r.source for r in rows],
                "fetched_at": [r.fetched_at for r in rows],
            },
            index=pd.Index([r.day for r in rows], name="day"),
        )
        fresh = self._freshness(frame, expected, st, allowed_lag=MACRO_ALLOWED_LAG_SESSIONS)
        return SeriesResult(sid, frame["value"].astype(float), fresh)

    # --- freshness ----------------------------------------------------------------------------

    def _freshness(
        self, df: pd.DataFrame, expected: date, st: _FetchState, allowed_lag: int
    ) -> Freshness:
        failing = st.failing
        err = st.last_error if failing else ""
        if df.empty:
            return Freshness(None, None, None, expected, True, "no data cached", err)
        last_day: date = df.index.max()
        source = str(df["source"].iloc[-1])
        fetched_at: datetime = max(df["fetched_at"])
        threshold = expected
        for _ in range(allowed_lag):
            threshold = self.calendar.previous_session(threshold)
        if last_day < threshold:
            missing = len(self.calendar.sessions_between(last_day, expected)) - 1
            reason = f"latest data is {last_day.isoformat()}, {missing} session(s) behind"
            if failing:
                reason += "; last refresh failed"
            return Freshness(source, fetched_at, last_day, expected, True, reason, err)
        return Freshness(source, fetched_at, last_day, expected, False, "", err)

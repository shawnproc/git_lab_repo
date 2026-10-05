"""Fetch, cache and read SEC fundamentals for the candidate list."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Protocol

from sqlalchemy import delete, func, select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session, sessionmaker

from keystone_ledger.core.auth import Clock, utcnow
from keystone_ledger.core.screen import (
    DURATION_TAGS,
    EPS_TAGS,
    INSTANT_TAGS,
    Facts,
    duration_period,
    instant_period,
)
from keystone_ledger.data.base import ProviderError
from keystone_ledger.data.sec_provider import FrameValue, TickerInfo
from keystone_ledger.db.models import FetchLog, FundamentalFact, SecTicker

log = logging.getLogger(__name__)

YEARS_BACK = 5
TICKER_MAX_AGE = timedelta(days=30)


class FundamentalsProvider(Protocol):
    name: str

    def fetch_tickers(self) -> dict[str, TickerInfo]: ...

    def fetch_frame(self, tag: str, period: str, unit: str = "USD") -> dict[int, FrameValue]: ...


def sec_ticker(symbol: str) -> str:
    """SEC lists share classes with dashes (BRK-B)."""
    return symbol.upper().replace(".", "-")


@dataclass(frozen=True)
class FundamentalsStatus:
    source: str | None
    fetched_at: datetime | None
    stale: bool
    reason: str
    last_error: str


class FundamentalsService:
    def __init__(
        self,
        session_factory: sessionmaker[Session],
        provider: FundamentalsProvider,
        max_age: timedelta,
        clock: Clock = utcnow,
    ) -> None:
        self._sf = session_factory
        self.provider = provider
        self.max_age = max_age
        self.clock = clock

    def years(self) -> list[int]:
        """Calendar years to consider, newest first (current year isn't complete yet)."""
        y = self.clock().year
        return [y - i for i in range(1, YEARS_BACK + 1)]

    # --- refresh ------------------------------------------------------------------------------

    def _tickers_fresh(self, s: Session) -> bool:
        newest = s.scalar(select(func.max(SecTicker.fetched_at)))
        return newest is not None and self.clock() - newest < TICKER_MAX_AGE

    def _log(self, ok: bool, started: datetime, rows: int = 0, error: str = "") -> FetchLog:
        return FetchLog(
            dataset="fundamentals", key="frames", provider=self.provider.name,
            started_at=started, ok=ok, rows=rows, error=error[:500],
        )  # fmt: skip

    def refresh(self, symbols: list[str], force: bool = False, all_companies: bool = False) -> None:
        """Fetch every tag/period frame and keep rows for our candidates' CIKs only.

        Network calls happen outside any write transaction; the facts table is then replaced
        in one transaction so a company's numbers never mix two refreshes.
        """
        started = self.clock()
        with self._sf() as s:
            if not force and not self.status(s).stale:
                return
            tickers_fresh = self._tickers_fresh(s)
        rows: list[dict[str, object]] = []
        try:
            if not tickers_fresh:
                tickers = self.provider.fetch_tickers()
                with self._sf() as s, s.begin():
                    s.execute(delete(SecTicker))
                    s.execute(
                        sqlite_insert(SecTicker),
                        [
                            {"ticker": t, "cik": i.cik, "title": i.title, "fetched_at": started}
                            for t, i in tickers.items()
                        ],
                    )
            with self._sf() as s:
                # all_companies: keep every filer (the frames already return them all), for search.
                ciks = (set(s.scalars(select(SecTicker.cik)).all()) if all_companies
                        else set(self.cik_map(s, symbols).values()))  # fmt: skip
            for year in self.years():
                for tags, period, unit in (
                    (DURATION_TAGS, duration_period(year), "USD"),
                    (INSTANT_TAGS, instant_period(year), "USD"),
                    (EPS_TAGS, duration_period(year), "USD-per-shares"),
                ):
                    for tag in tags:
                        frame = self.provider.fetch_frame(tag, period, unit)
                        rows += [
                            {
                                "cik": cik, "tag": tag, "period": period, "value": fv.value,
                                "end": fv.end, "accn": fv.accn, "source": self.provider.name,
                                "fetched_at": started,
                            }
                            for cik, fv in frame.items()
                            if cik in ciks
                        ]  # fmt: skip
        except (ProviderError, ValueError) as exc:
            with self._sf() as s, s.begin():
                s.add(self._log(False, started, error=str(exc)))
            log.warning("fundamentals: refresh failed: %s", exc)
            return
        with self._sf() as s, s.begin():
            s.execute(delete(FundamentalFact).where(FundamentalFact.cik.in_(ciks)))
            for i in range(0, len(rows), 500):
                s.execute(sqlite_insert(FundamentalFact), rows[i : i + 500])
            s.add(self._log(True, started, rows=len(rows)))

    # --- read ---------------------------------------------------------------------------------

    def all_tickers(self) -> dict[str, tuple[int, str]]:
        """Every SEC-listed ticker -> (CIK, company name)."""
        with self._sf() as s:
            rows = s.execute(select(SecTicker.ticker, SecTicker.cik, SecTicker.title)).all()
        return {t.replace("-", "."): (cik, title) for t, cik, title in rows}

    @staticmethod
    def cik_map(s: Session, symbols: list[str]) -> dict[str, int]:
        wanted = {sec_ticker(sym): sym for sym in symbols}
        rows = s.execute(
            select(SecTicker.ticker, SecTicker.cik).where(SecTicker.ticker.in_(wanted))
        ).all()
        return {wanted[t]: cik for t, cik in rows}

    def company_names(self, symbols: list[str]) -> dict[str, str]:
        wanted = {sec_ticker(sym): sym for sym in symbols}
        with self._sf() as s:
            rows = s.execute(
                select(SecTicker.ticker, SecTicker.title).where(SecTicker.ticker.in_(wanted))
            ).all()
        return {wanted[t]: title for t, title in rows}

    def facts(self, symbols: list[str]) -> dict[str, Facts]:
        with self._sf() as s:
            cmap = self.cik_map(s, symbols)
            by_cik: dict[int, dict[tuple[str, str], float]] = {c: {} for c in cmap.values()}
            for f in s.scalars(
                select(FundamentalFact).where(FundamentalFact.cik.in_(list(by_cik)))
            ):
                by_cik[f.cik][(f.tag, f.period)] = f.value
        return {sym: by_cik[cik] for sym, cik in cmap.items()}

    def status(self, s: Session | None = None) -> FundamentalsStatus:
        if s is None:
            with self._sf() as s2:
                return self.status(s2)
        rows = s.scalars(
            select(FetchLog)
            .where(FetchLog.dataset == "fundamentals")
            .order_by(FetchLog.started_at.desc(), FetchLog.id.desc())
            .limit(20)
        ).all()
        last_ok = next((r for r in rows if r.ok), None)
        last_fail = next((r for r in rows if not r.ok), None)
        failing = last_fail is not None and (
            last_ok is None or last_fail.started_at > last_ok.started_at
        )
        err = last_fail.error if failing and last_fail else ""
        if last_ok is None:
            return FundamentalsStatus(None, None, True, "fundamentals never fetched", err)
        age = self.clock() - last_ok.started_at
        stale = age > self.max_age
        reason = f"fundamentals are {age.days} days old" if stale else ""
        return FundamentalsStatus(last_ok.provider, last_ok.started_at, stale, reason, err)

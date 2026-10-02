"""NYSE trading calendar (holidays, early closes) via `exchange_calendars`."""

from __future__ import annotations

from datetime import date, datetime
from functools import lru_cache
from typing import Any

import pandas as pd


@lru_cache(maxsize=1)
def _xnys() -> Any:
    import exchange_calendars as xcals

    return xcals.get_calendar("XNYS", start="1990-01-02")


class MarketCalendar:
    def __init__(self, cal: Any = None) -> None:
        self._cal = cal if cal is not None else _xnys()

    def is_session(self, d: date) -> bool:
        return bool(self._cal.is_session(pd.Timestamp(d)))

    def last_completed_session(self, now: datetime) -> date:
        """Most recent session whose close (incl. early closes) is at or before `now`."""
        if now.tzinfo is None:
            raise ValueError("now must be timezone-aware")
        ts = pd.Timestamp(now).tz_convert("UTC")
        ny_day = pd.Timestamp(ts.tz_convert("America/New_York").date())
        session = self._cal.date_to_session(ny_day, "previous")
        if self._cal.session_close(session) > ts:
            session = self._cal.previous_session(session)
        return pd.Timestamp(session).date()

    def previous_session(self, d: date) -> date:
        """The session strictly before `d`."""
        s = self._cal.date_to_session(pd.Timestamp(d), "next")
        return pd.Timestamp(self._cal.previous_session(s)).date()

    def sessions_between(self, start: date, end: date) -> list[date]:
        """Sessions in [start, end] inclusive."""
        if end < start:
            return []
        sessions = self._cal.sessions_in_range(pd.Timestamp(start), pd.Timestamp(end))
        return [pd.Timestamp(s).date() for s in sessions]

    def add_sessions(self, d: date, n: int) -> date:
        """The session `n` trading days after `d` (d snapped forward to a session first)."""
        s = self._cal.date_to_session(pd.Timestamp(d), "next")
        return pd.Timestamp(self._cal.session_offset(s, n)).date()

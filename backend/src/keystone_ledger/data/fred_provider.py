"""Macro series (e.g. VIXCLS) via FRED's public `fredgraph.csv` export (no API key).

FRED's JSON API needs a free key (account required); the CSV export behind every FRED chart does
not, so we use it and keep requests sparse. Missing observations are encoded as "." and dropped.
Some series carry third-party copyright (VIXCLS is Cboe's); personal, non-redistributed use only.
"""

from __future__ import annotations

import io
from datetime import date

import httpx
import pandas as pd

from keystone_ledger.data.base import ProviderError, RateLimitedError, validate_series_id
from keystone_ledger.data.ratelimit import MinIntervalLimiter

FRED_CSV_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv"
_MAX_BYTES = 5_000_000


def parse_fred_csv(text: str, series_id: str) -> pd.Series:
    df = pd.read_csv(io.StringIO(text), dtype=str)
    if df.shape[1] != 2 or series_id not in df.columns:
        raise ProviderError("fred: unexpected CSV layout")
    date_col = df.columns[0]
    values = pd.to_numeric(df[series_id].replace(".", None), errors="coerce")
    idx = pd.to_datetime(df[date_col], format="%Y-%m-%d", errors="coerce")
    ok = idx.notna() & values.notna()
    out = pd.Series(values[ok].to_numpy(), index=[d.date() for d in idx[ok]], name=series_id)
    out.index.name = "day"
    return out


class FredCsvProvider:
    name = "fred_csv"

    def __init__(self, limiter: MinIntervalLimiter, client: httpx.Client | None = None) -> None:
        self._limiter = limiter
        self._client = client or httpx.Client(
            timeout=20.0,
            follow_redirects=False,
            headers={"User-Agent": "KeystoneLedger/0.1 (personal research tool)"},
        )

    def fetch_series(self, series_id: str, start: date, end: date) -> pd.Series:
        sid = validate_series_id(series_id)
        self._limiter.wait()
        try:
            resp = self._client.get(
                FRED_CSV_URL,
                params={"id": sid, "cosd": start.isoformat(), "coed": end.isoformat()},
            )
        except httpx.HTTPError as exc:
            raise ProviderError(f"fred: {type(exc).__name__}") from exc
        if resp.status_code == 429:
            raise RateLimitedError("fred: rate limited")
        if resp.status_code != 200:
            raise ProviderError(f"fred: HTTP {resp.status_code}")
        if len(resp.content) > _MAX_BYTES:
            raise ProviderError("fred: response too large")
        if "text/csv" not in resp.headers.get("content-type", ""):
            raise ProviderError("fred: response was not CSV")
        return parse_fred_csv(resp.text, sid)

"""Company fundamentals from SEC EDGAR's free XBRL APIs (no key, no account).

Fair-access rules (sec.gov "Accessing EDGAR Data"): at most 10 requests/second, and every request
must carry a User-Agent naming you and a contact address (`KL_SEC_USER_AGENT`). We default to
5 req/s.

We use the **frames** API: one request returns one XBRL tag for one calendar period across every
filer (e.g. all companies' `Revenues` for CY2024). ~50 requests cover the whole screen, versus
hundreds of multi-MB per-company files. Fiscal years that aren't calendar years are mapped by the
SEC to the calendar frame they best fit.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from datetime import date
from typing import Any

import httpx

from keystone_ledger.data.base import ProviderError, RateLimitedError
from keystone_ledger.data.ratelimit import MinIntervalLimiter

TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
FRAMES_URL = "https://data.sec.gov/api/xbrl/frames/us-gaap/{tag}/{unit}/{period}.json"
# Dollar amounts, and per-share amounts like earnings per share.
UNITS = frozenset({"USD", "USD-per-shares"})
_MAX_BYTES = 40_000_000
_TAG_OK = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz")


@dataclass(frozen=True)
class FrameValue:
    value: float
    end: date
    accn: str


@dataclass(frozen=True)
class TickerInfo:
    cik: int
    title: str


def parse_tickers(payload: Any) -> dict[str, TickerInfo]:
    """`company_tickers.json` is {"0": {"cik_str": 320193, "ticker": "AAPL", "title": ...}}."""
    if not isinstance(payload, dict):
        raise ProviderError("sec: unexpected tickers payload")
    out: dict[str, TickerInfo] = {}
    for row in payload.values():
        try:
            ticker = str(row["ticker"]).upper()
            cik = int(row["cik_str"])
            title = str(row["title"])[:256]
        except (KeyError, TypeError, ValueError):
            continue
        if 0 < cik < 10**10 and 0 < len(ticker) <= 16:
            out.setdefault(ticker, TickerInfo(cik, title))
    if not out:
        raise ProviderError("sec: empty tickers payload")
    return out


def parse_frame(payload: Any) -> dict[int, FrameValue]:
    """Frames payload: {"data": [{"cik": 320193, "end": "2024-09-28", "val": 1.0, "accn": ..}]}."""
    if not isinstance(payload, dict) or not isinstance(payload.get("data"), list):
        raise ProviderError("sec: unexpected frame payload")
    out: dict[int, FrameValue] = {}
    for row in payload["data"]:
        try:
            cik = int(row["cik"])
            val = float(row["val"])
            end = date.fromisoformat(str(row["end"]))
            accn = str(row.get("accn", ""))[:32]
        except (KeyError, TypeError, ValueError):
            continue
        if math.isfinite(val) and abs(val) < 1e16:  # drop NaN / absurd values, never repair
            out[cik] = FrameValue(val, end, accn)
    return out


class SecEdgarProvider:
    name = "sec_edgar"

    def __init__(
        self, user_agent: str, limiter: MinIntervalLimiter, client: httpx.Client | None = None
    ) -> None:
        self._ua = user_agent.strip()
        self._limiter = limiter
        self._client = client or httpx.Client(timeout=30.0, follow_redirects=False)

    def _get_json(self, url: str) -> Any | None:
        if "@" not in self._ua:
            raise ProviderError(
                "sec: set KL_SEC_USER_AGENT in .env (name + email), required by the SEC"
            )
        self._limiter.wait()
        try:
            resp = self._client.get(
                url, headers={"User-Agent": self._ua, "Accept": "application/json"}
            )
        except httpx.HTTPError as exc:
            raise ProviderError(f"sec: {type(exc).__name__}") from exc
        if resp.status_code == 404:
            return None  # no filer reported this tag for this period
        if resp.status_code in (403, 429):
            raise RateLimitedError(f"sec: HTTP {resp.status_code} (rate limit or User-Agent)")
        if resp.status_code != 200:
            raise ProviderError(f"sec: HTTP {resp.status_code}")
        if len(resp.content) > _MAX_BYTES:
            raise ProviderError("sec: response too large")
        try:
            return json.loads(resp.content)
        except ValueError as exc:
            raise ProviderError("sec: invalid JSON") from exc

    def fetch_tickers(self) -> dict[str, TickerInfo]:
        return parse_tickers(self._get_json(TICKERS_URL))

    def fetch_frame(self, tag: str, period: str, unit: str = "USD") -> dict[int, FrameValue]:
        if unit not in UNITS:
            raise ValueError(f"invalid unit {unit!r}")
        if not tag or not set(tag) <= _TAG_OK or len(tag) > 128:
            raise ValueError(f"invalid XBRL tag {tag!r}")
        if not (len(period) in (6, 9) and period.startswith("CY") and period[2:6].isdigit()):
            raise ValueError(f"invalid frame period {period!r}")
        payload = self._get_json(FRAMES_URL.format(tag=tag, unit=unit, period=period))
        return {} if payload is None else parse_frame(payload)

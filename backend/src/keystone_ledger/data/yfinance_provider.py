"""Daily prices via the `yfinance` library (Yahoo Finance; no API key).

Terms: Yahoo's data is for personal use. That fits this single-user local app; don't redistribute.
Limits: Yahoo publishes no quota and rate-limits aggressively (YFRateLimitError), especially from
data-center IPs. We pace ourselves (`MinIntervalLimiter`), fetch incrementally and cache in SQLite.

`repair=False` on purpose: yfinance's "price repair" rewrites values it believes are bad. That is
inference, not data, so we take the raw response and let `validate_bars` drop bad rows instead.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any

import pandas as pd

from keystone_ledger.data.base import (
    BAR_COLUMNS,
    ProviderError,
    RateLimitedError,
    SymbolNotFoundError,
    validate_symbol,
)
from keystone_ledger.data.ratelimit import MinIntervalLimiter

_RENAME = {
    "Open": "open",
    "High": "high",
    "Low": "low",
    "Close": "close",
    "Adj Close": "adj_close",
    "Volume": "volume",
}


def to_yahoo_symbol(symbol: str) -> str:
    """BRK.B -> BRK-B (Yahoo uses dashes for share classes)."""
    return symbol.replace(".", "-")


def normalize_history(raw: pd.DataFrame) -> pd.DataFrame:
    """Map a yfinance `history()` frame to our schema, indexed by exchange-local `date`."""
    if raw.empty:
        return pd.DataFrame(columns=list(BAR_COLUMNS))
    df = raw.rename(columns=_RENAME)
    missing = [c for c in BAR_COLUMNS if c not in df.columns]
    if missing:
        raise ProviderError(f"yfinance response missing columns: {missing}")
    idx = pd.DatetimeIndex(df.index)
    # Daily bars are stamped at exchange-local midnight; take the local calendar date.
    df.index = pd.Index([ts.date() for ts in idx], name="day")
    return df.loc[:, list(BAR_COLUMNS)]


class YFinanceProvider:
    name = "yfinance"

    def __init__(self, limiter: MinIntervalLimiter, ticker_factory: Any = None) -> None:
        self._limiter = limiter
        if ticker_factory is None:
            import yfinance as yf

            ticker_factory = yf.Ticker
        self._ticker_factory = ticker_factory

    def fetch_daily_bars(self, symbol: str, start: date, end: date) -> pd.DataFrame:
        from yfinance import exceptions as yfe

        sym = validate_symbol(symbol)
        self._limiter.wait()
        try:
            raw = self._ticker_factory(to_yahoo_symbol(sym)).history(
                start=start.isoformat(),
                end=(end + timedelta(days=1)).isoformat(),  # yfinance `end` is exclusive
                interval="1d",
                auto_adjust=False,
                actions=False,
                repair=False,
                raise_errors=True,
                timeout=20,
            )
        except yfe.YFRateLimitError as exc:
            raise RateLimitedError("yfinance: rate limited by Yahoo") from exc
        except (yfe.YFTickerMissingError, yfe.YFTzMissingError) as exc:
            # yfinance raises these both for unknown symbols and when Yahoo is unreachable.
            raise SymbolNotFoundError(
                f"yfinance: no data for {sym} (unknown symbol, or Yahoo unreachable)"
            ) from exc
        except yfe.YFPricesMissingError:
            return normalize_history(pd.DataFrame())
        except Exception as exc:  # network, JSON, etc. Message is type-only: no URLs/cookies.
            raise ProviderError(f"yfinance: {type(exc).__name__}") from exc
        return normalize_history(raw)

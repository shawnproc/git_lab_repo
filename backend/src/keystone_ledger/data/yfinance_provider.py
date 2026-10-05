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


def splits_from(raw: pd.DataFrame) -> dict[date, float]:
    """Split ratios from yfinance's "Stock Splits" column (0 on ordinary days)."""
    if raw.empty or "Stock Splits" not in raw.columns:
        return {}
    col = pd.to_numeric(raw["Stock Splits"], errors="coerce")
    idx = pd.DatetimeIndex(raw.index)
    return {
        ts.date(): float(r)
        for ts, r in zip(idx, col, strict=True)
        if pd.notna(r) and 0 < float(r) < 1000 and float(r) != 1.0
    }


def dividends_from(raw: pd.DataFrame) -> dict[date, float]:
    """Cash dividends per share from yfinance's "Dividends" column (0 on ordinary days)."""
    if raw.empty or "Dividends" not in raw.columns:
        return {}
    col = pd.to_numeric(raw["Dividends"], errors="coerce")
    idx = pd.DatetimeIndex(raw.index)
    return {
        ts.date(): float(d)
        for ts, d in zip(idx, col, strict=True)
        if pd.notna(d) and 0 < float(d) < 10_000
    }


class YFinanceProvider:
    name = "yfinance"

    def __init__(self, limiter: MinIntervalLimiter, ticker_factory: Any = None) -> None:
        self._limiter = limiter
        if ticker_factory is None:
            import yfinance as yf

            ticker_factory = yf.Ticker
        self._ticker_factory = ticker_factory

    def fetch_daily_bars(self, symbol: str, start: date, end: date) -> pd.DataFrame:
        return self.fetch_history(symbol, start, end)[0]

    def fetch_top_holdings(self, symbol: str) -> list[tuple[str, float]]:
        """A fund's largest holdings as (ticker, % of the fund), as Yahoo publishes them."""
        sym = validate_symbol(symbol)
        self._limiter.wait()
        try:
            df = self._ticker_factory(to_yahoo_symbol(sym)).funds_data.top_holdings
        except Exception as exc:  # network, missing data: type only, no URLs
            raise ProviderError(f"yfinance: holdings unavailable ({type(exc).__name__})") from exc
        out: list[tuple[str, float]] = []
        if df is None or getattr(df, "empty", True):
            raise ProviderError("yfinance: holdings unavailable (empty)")
        col = "Holding Percent" if "Holding Percent" in df.columns else df.columns[-1]
        for ticker, frac in zip(df.index, pd.to_numeric(df[col], errors="coerce"), strict=True):
            t = str(ticker).strip().upper().replace("-", ".")
            if pd.notna(frac) and 0 < float(frac) < 1:
                out.append((t, round(float(frac) * 100, 4)))
        if not out:
            raise ProviderError("yfinance: holdings unavailable (no rows)")
        return out

    def fetch_history(
        self, symbol: str, start: date, end: date
    ) -> tuple[pd.DataFrame, dict[date, float], dict[date, float]]:
        """Daily bars, stock splits ({day: ratio}, 2.0 = 2-for-1) and cash dividends per share
        ({day: dollars}), all from the same request."""
        from yfinance import exceptions as yfe

        sym = validate_symbol(symbol)
        self._limiter.wait()
        try:
            raw = self._ticker_factory(to_yahoo_symbol(sym)).history(
                start=start.isoformat(),
                end=(end + timedelta(days=1)).isoformat(),  # yfinance `end` is exclusive
                interval="1d",
                auto_adjust=False,
                actions=True,  # adds Dividends / Stock Splits columns; bars ignore them
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
            return normalize_history(pd.DataFrame()), {}, {}
        except Exception as exc:  # network, JSON, etc. Message is type-only: no URLs/cookies.
            raise ProviderError(f"yfinance: {type(exc).__name__}") from exc
        return normalize_history(raw), splits_from(raw), dividends_from(raw)

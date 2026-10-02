"""Provider interfaces and the validation every fetched dataset must pass.

Principle: never fabricate. Invalid rows are dropped and counted, never repaired, interpolated or
forward-filled. Callers always get the provider name and fetch timestamp alongside the numbers.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date
from typing import Protocol, runtime_checkable

import numpy as np
import pandas as pd

BAR_COLUMNS = ("open", "high", "low", "close", "adj_close", "volume")
# Equities/ETFs (BRK.B, BF-B), indices (^GSPC, ^VIX). Nothing else gets near a URL or query.
SYMBOL_RE = re.compile(r"^\^?[A-Z0-9]{1,10}([.\-][A-Z0-9]{1,4})?$")
SERIES_RE = re.compile(r"^[A-Z0-9_]{1,32}$")


class ProviderError(Exception):
    """A provider call failed. Message must not contain secrets."""


class RateLimitedError(ProviderError):
    pass


class SymbolNotFoundError(ProviderError):
    pass


def validate_symbol(symbol: str) -> str:
    sym = symbol.strip().upper()
    if not SYMBOL_RE.fullmatch(sym):
        raise ValueError(f"invalid symbol: {symbol!r}")
    return sym


def validate_series_id(series_id: str) -> str:
    sid = series_id.strip().upper()
    if not SERIES_RE.fullmatch(sid):
        raise ValueError(f"invalid series id: {series_id!r}")
    return sid


@runtime_checkable
class PriceProvider(Protocol):
    name: str

    def fetch_daily_bars(self, symbol: str, start: date, end: date) -> pd.DataFrame:
        """Daily bars for [start, end] inclusive.

        Returns a DataFrame indexed by `datetime.date` (ascending, unique) with exactly
        `BAR_COLUMNS`. `close` is split-adjusted; `adj_close` is split- and dividend-adjusted.
        """
        ...


@runtime_checkable
class MacroProvider(Protocol):
    name: str

    def fetch_series(self, series_id: str, start: date, end: date) -> pd.Series:
        """Observations for [start, end] inclusive, indexed by `datetime.date`, float values."""
        ...


@dataclass(frozen=True)
class ValidationReport:
    rows_in: int
    rows_out: int
    dropped: dict[str, int]


def validate_bars(df: pd.DataFrame) -> tuple[pd.DataFrame, ValidationReport]:
    """Drop rows that violate OHLCV invariants. Never modifies values."""
    rows_in = len(df)
    missing = [c for c in BAR_COLUMNS if c not in df.columns]
    if missing:
        raise ProviderError(f"provider response missing columns: {missing}")
    out = df.loc[:, list(BAR_COLUMNS)].copy()
    out = out.apply(pd.to_numeric, errors="coerce")
    dropped: dict[str, int] = {}

    def _drop(mask: pd.Series, reason: str) -> None:
        nonlocal out
        n = int(mask.sum())
        if n:
            dropped[reason] = dropped.get(reason, 0) + n
            out = out.loc[~mask]

    _drop(out.isna().any(axis=1) | ~np.isfinite(out).all(axis=1), "non_finite")
    _drop((out[["open", "high", "low", "close", "adj_close"]] <= 0).any(axis=1), "non_positive")
    _drop(out["volume"] < 0, "negative_volume")
    # 0.5% tolerance: some sources round OHLC independently.
    tol = 1.005
    _drop(out["high"] * tol < out[["open", "close", "low"]].max(axis=1), "high_below_body")
    _drop(out["low"] > out[["open", "close", "high"]].min(axis=1) * tol, "low_above_body")
    dup = out.index.duplicated(keep="last")
    _drop(pd.Series(dup, index=out.index), "duplicate_date")
    out = out.sort_index()
    return out, ValidationReport(rows_in=rows_in, rows_out=len(out), dropped=dropped)


def validate_series(s: pd.Series) -> tuple[pd.Series, ValidationReport]:
    rows_in = len(s)
    out = pd.to_numeric(s, errors="coerce")
    finite = out.notna() & np.isfinite(out)
    dropped = {"non_finite": int((~finite).sum())} if (~finite).any() else {}
    out = out[finite]
    out = out[~out.index.duplicated(keep="last")].sort_index()
    return out.astype(float), ValidationReport(rows_in, len(out), dropped)

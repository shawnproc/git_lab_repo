"""Provider selection by name, from config. Add new sources here behind the same interfaces."""

from __future__ import annotations

from keystone_ledger.config import AppConfig
from keystone_ledger.data.base import MacroProvider, PriceProvider
from keystone_ledger.data.fred_provider import FredCsvProvider
from keystone_ledger.data.ratelimit import MinIntervalLimiter
from keystone_ledger.data.yfinance_provider import YFinanceProvider
from keystone_ledger.settings import Settings


def build_price_provider(cfg: AppConfig, settings: Settings) -> PriceProvider:
    name = cfg.data.price_provider
    limiter = MinIntervalLimiter(cfg.data.max_requests_per_second)
    if name == "yfinance":
        return YFinanceProvider(limiter)
    raise ValueError(f"unknown price provider: {name!r}")


def build_macro_provider(cfg: AppConfig) -> MacroProvider:
    name = cfg.data.macro_provider
    limiter = MinIntervalLimiter(cfg.data.max_requests_per_second)
    if name == "fred_csv":
        return FredCsvProvider(limiter)
    raise ValueError(f"unknown macro provider: {name!r}")

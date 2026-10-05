"""Investment-plan configuration (TOML), validated and frozen at startup.

Design rules:
* The file is read once, at process start. No runtime API mutates these values, so the plan
  (and its guardrails) only changes by editing the file and restarting.
* Hard ceilings are enforced by the schema and the engine; a config that breaks them won't load.
* Every change to the effective config is recorded in the `config_audit` table on startup.
"""

from __future__ import annotations

import hashlib
import json
import re
import tomllib
from pathlib import Path
from typing import Annotated, Any

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

# No single stock may exceed this share of the portfolio, whatever the config says. If fewer
# stocks pass the screen, the excess goes to the core funds instead of concentrating.
HARD_MAX_SINGLE_STOCK_PCT = 10.0
MAX_CANDIDATES = 60

Pct = Annotated[float, Field(ge=0, le=100)]
_SYMBOL = re.compile(r"^[A-Z0-9]{1,10}([.\-][A-Z0-9]{1,4})?$")

# 40 large, profitable US companies across sectors (no banks/insurers/REITs: their statements
# don't fit revenue/operating-margin/FCF screens). Sector labels drive the per-sector cap.
DEFAULT_CANDIDATES: dict[str, str] = {
    "AAPL": "Technology", "MSFT": "Technology", "NVDA": "Technology", "AVGO": "Technology",
    "ORCL": "Technology", "ADBE": "Technology", "CRM": "Technology", "TXN": "Technology",
    "QCOM": "Technology", "ACN": "Technology",
    "GOOGL": "Communication", "META": "Communication",
    "AMZN": "Consumer Discretionary", "HD": "Consumer Discretionary",
    "LOW": "Consumer Discretionary", "MCD": "Consumer Discretionary",
    "NKE": "Consumer Discretionary", "SBUX": "Consumer Discretionary",
    "PG": "Consumer Staples", "KO": "Consumer Staples", "PEP": "Consumer Staples",
    "COST": "Consumer Staples", "WMT": "Consumer Staples",
    "JNJ": "Health Care", "UNH": "Health Care", "LLY": "Health Care", "ABT": "Health Care",
    "TMO": "Health Care", "ISRG": "Health Care",
    "V": "Financials", "MA": "Financials",
    "CAT": "Industrials", "DE": "Industrials", "HON": "Industrials", "UNP": "Industrials",
    "LMT": "Industrials",
    "XOM": "Energy", "CVX": "Energy",
    "LIN": "Materials",
    "NEE": "Utilities",
}  # fmt: skip

# Popular funds and stocks the daily snapshot also prices, so most holdings get a daily price and
# a chart. Deliberately broad: the snapshot is public, and a short list would reveal what you own.
DEFAULT_EXTRA_TICKERS: tuple[str, ...] = (
    # funds
    "SPY", "VOO", "IVV", "QQQ", "QQQM", "VT", "ITOT", "SCHB", "SCHX", "SCHG", "SCHD",
    "VUG", "VTV", "VIG", "VYM", "DGRO", "JEPI", "IXUS", "VEA", "VWO", "BND", "AGG", "VNQ", "IWM",
    "DIA", "VGT", "XLK", "XLE", "XLF", "XLV", "SMH", "SOXX", "ARKK",
    # stocks
    "TSLA", "AMD", "INTC", "MU", "CSCO", "IBM", "NFLX", "DIS", "PYPL", "UBER", "ABNB", "SPOT",
    "PLTR", "SHOP", "SNAP", "ROKU", "COIN", "HOOD", "SOFI", "JPM", "BAC", "WFC", "C", "BRK.B",
    "F", "GM", "RIVN", "LCID", "NIO", "BA", "DAL", "AAL", "CCL", "T", "VZ", "PFE", "MRK", "ABBV",
    "MRNA", "COP", "OXY", "O", "BABA", "GME", "AMC",
)  # fmt: skip
MAX_EXTRA_TICKERS = 200


class _Frozen(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class CoreFund(_Frozen):
    symbol: str
    name: str = Field(default="", max_length=120)
    weight_pct: float = Field(gt=0, le=100)
    why: str = Field(default="", max_length=600)

    @field_validator("symbol")
    @classmethod
    def _sym(cls, v: str) -> str:
        v = v.strip().upper()
        if not _SYMBOL.fullmatch(v):
            raise ValueError(f"invalid symbol {v!r}")
        return v


DEFAULT_CORE = (
    CoreFund(
        symbol="VTI",
        name="Vanguard Morningstar Total Stock Market ETF",
        weight_pct=45.0,
        why=(
            "One fund that owns a small piece of nearly every public company in the US, big and "
            "small (it follows the Morningstar US Total Market Index, formerly called CRSP). "
            "It's the foundation of the plan: you don't have to pick winners, because you own "
            "them all."
        ),
    ),
    CoreFund(
        symbol="VXUS",
        name="Vanguard Total International Stock ETF",
        weight_pct=15.0,
        why=(
            "One fund that owns thousands of companies outside the US, in places like Japan, "
            "Europe and Canada (it follows the FTSE Global All Cap ex US Index). It protects you "
            "if the US has a slow decade while other countries do well."
        ),
    ),
)


class ScreenConfig(_Frozen):
    revenue_years: int = Field(default=3, ge=2, le=4)
    min_revenue_cagr_pct: float = Field(default=5.0, ge=-50, le=100)
    min_operating_margin_pct: float = Field(default=12.0, ge=-50, le=100)
    # Margin "not shrinking": latest vs two years earlier, allowed to slip this many points.
    margin_trend_tolerance_pp: float = Field(default=1.0, ge=0, le=20)
    require_positive_fcf: bool = True
    # Debt measured in years of operating profit (works even with negative book equity).
    max_debt_to_operating_income: float = Field(default=3.0, gt=0, le=50)
    # A candidate may have at most this many checks "unavailable" and still qualify.
    max_unavailable: int = Field(default=1, ge=0, le=2)
    # Replace a pick (new money stops; nothing is sold) only after this many failed quarterly
    # check-ins in a row. One failure = "on watch". At least 2, so one bad report can't churn it.
    replace_after_failed_quarters: int = Field(default=2, ge=2, le=8)
    # Price check: flag when today's P/E is above this multiple of its own 5-year median P/E.
    # A flag only sends new buy-day money elsewhere for now; it never sells or blocks the plan.
    valuation_pe_multiple: float = Field(default=1.5, ge=1.1, le=5.0)


class PlanConfig(_Frozen):
    core_pct: Pct = 60.0
    stocks_pct: Pct = 40.0
    core_funds: tuple[CoreFund, ...] = DEFAULT_CORE
    max_stocks: int = Field(default=10, ge=0, le=10)
    max_per_sector: int = Field(default=2, ge=1, le=10)
    max_single_stock_pct: float = Field(default=8.0, gt=0, le=HARD_MAX_SINGLE_STOCK_PCT)
    candidates: dict[str, str] = Field(default_factory=lambda: dict(DEFAULT_CANDIDATES))
    # Used for dollar targets when no holdings are entered yet.
    reference_amount: float = Field(default=10_000.0, gt=0, le=100_000_000)

    @field_validator("candidates")
    @classmethod
    def _cands(cls, v: dict[str, str]) -> dict[str, str]:
        if len(v) > MAX_CANDIDATES:
            raise ValueError(f"at most {MAX_CANDIDATES} candidates")
        out: dict[str, str] = {}
        for sym, sector in v.items():
            s = sym.strip().upper()
            if not _SYMBOL.fullmatch(s):
                raise ValueError(f"invalid candidate symbol {sym!r}")
            if not 1 <= len(sector) <= 40:
                raise ValueError(f"invalid sector for {s}")
            out[s] = sector
        return out

    @model_validator(mode="after")
    def _consistent(self) -> PlanConfig:
        if abs(self.core_pct + self.stocks_pct - 100.0) > 1e-9:
            raise ValueError("core_pct + stocks_pct must equal 100")
        if not 1 <= len(self.core_funds) <= 3:
            raise ValueError("use 1-3 core funds")
        core_total = sum(f.weight_pct for f in self.core_funds)
        if abs(core_total - self.core_pct) > 1e-6:
            raise ValueError(f"core fund weights sum to {core_total}, expected {self.core_pct}")
        syms = [f.symbol for f in self.core_funds]
        if len(set(syms)) != len(syms):
            raise ValueError("duplicate core fund")
        if set(syms) & set(self.candidates):
            raise ValueError("a core fund cannot also be a stock candidate")
        return self


class DriftConfig(_Frozen):
    # Flag when actual weight is this many percentage points from target...
    max_abs_pp: float = Field(default=5.0, gt=0, le=50)
    # ...or this far off relative to its own target (25% of a 6% target = 1.5 points).
    max_relative_pct: float = Field(default=25.0, gt=0, le=100)


class ContributionConfig(_Frozen):
    fractional_shares: bool = True


class MoodConfig(_Frozen):
    index: str = "^GSPC"
    ma_days: int = Field(default=200, ge=20, le=400)
    vix_green_below: float = Field(default=20.0, gt=0)
    vix_red_above: float = Field(default=30.0, gt=0)

    @model_validator(mode="after")
    def _ordering(self) -> MoodConfig:
        if self.vix_green_below >= self.vix_red_above:
            raise ValueError("vix_green_below must be below vix_red_above")
        return self


class DataConfig(_Frozen):
    price_provider: str = "yfinance"
    macro_provider: str = "fred_csv"
    fundamentals_provider: str = "sec_edgar"
    history_years: int = Field(default=5, ge=2, le=40)
    # Self-imposed pacing per provider, below any published limit.
    max_requests_per_second: float = Field(default=1.0, gt=0, le=10)
    sec_requests_per_second: float = Field(default=5.0, gt=0, le=9)  # SEC limit is 10/s
    fundamentals_max_age_days: int = Field(default=30, ge=1, le=365)
    # Extra tickers to price daily for the phone (public). See DEFAULT_EXTRA_TICKERS.
    extra_tickers: tuple[str, ...] = DEFAULT_EXTRA_TICKERS

    @field_validator("extra_tickers")
    @classmethod
    def _extra(cls, v: tuple[str, ...]) -> tuple[str, ...]:
        out = tuple(dict.fromkeys(s.strip().upper() for s in v))
        if len(out) > MAX_EXTRA_TICKERS:
            raise ValueError(f"at most {MAX_EXTRA_TICKERS} extra tickers")
        bad = [s for s in out if not _SYMBOL.fullmatch(s)]
        if bad:
            raise ValueError(f"invalid ticker(s): {bad[:5]}")
        return out


class AppConfig(_Frozen):
    plan: PlanConfig = PlanConfig()
    screen: ScreenConfig = ScreenConfig()
    drift: DriftConfig = DriftConfig()
    contribution: ContributionConfig = ContributionConfig()
    mood: MoodConfig = MoodConfig()
    data: DataConfig = DataConfig()

    def canonical_json(self) -> str:
        return json.dumps(self.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))

    def fingerprint(self) -> str:
        return hashlib.sha256(self.canonical_json().encode()).hexdigest()


def load_config(path: Path) -> AppConfig:
    """Load and validate the TOML config. A missing file means 'all defaults'."""
    if not path.exists():
        return AppConfig()
    with path.open("rb") as fh:
        raw: dict[str, Any] = tomllib.load(fh)
    return AppConfig.model_validate(raw)


def diff_configs(old: dict[str, Any], new: dict[str, Any], prefix: str = "") -> dict[str, Any]:
    """Flat {dotted.key: [old, new]} diff of two nested config dicts."""
    out: dict[str, Any] = {}
    for key in sorted(set(old) | set(new)):
        dotted = f"{prefix}{key}"
        o, n = old.get(key), new.get(key)
        if isinstance(o, dict) and isinstance(n, dict):
            out.update(diff_configs(o, n, f"{dotted}."))
        elif o != n:
            out[dotted] = [o, n]
    return out

"""Trading-rule configuration (TOML), validated and frozen at startup.

Design rules:
* The file is read once, at process start. There is no runtime API that mutates these values, so
  the 1% risk cap (and every other guardrail) can only change by editing the file and restarting.
* Hard ceilings are enforced by the schema itself; a config that exceeds them refuses to load.
* Every change to the effective config is recorded in the `config_audit` table on startup.
"""

from __future__ import annotations

import hashlib
import json
import tomllib
from pathlib import Path
from typing import Annotated, Any

from pydantic import BaseModel, ConfigDict, Field, model_validator

# Absolute ceilings. Raising these requires a code change, review and a restart.
HARD_MAX_RISK_PER_TRADE_PCT = 1.0
HARD_MAX_POSITION_PCT = 10.0
HARD_MAX_SECTOR_PCT = 30.0

Pct = Annotated[float, Field(ge=0, le=100)]


class _Frozen(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class SleeveConfig(_Frozen):
    core_pct: Pct = 50.0
    swing_pct: Pct = 25.0
    growth_pct: Pct = 25.0

    @model_validator(mode="after")
    def _sums_to_100(self) -> SleeveConfig:
        total = self.core_pct + self.swing_pct + self.growth_pct
        if abs(total - 100.0) > 1e-9:
            raise ValueError(f"sleeves must sum to 100%, got {total}")
        return self


class AccountConfig(_Frozen):
    starting_equity: float = Field(default=10_000.0, gt=0, le=100_000_000)
    sleeves: SleeveConfig = SleeveConfig()


class SwingRiskConfig(_Frozen):
    risk_per_trade_pct: float = Field(default=1.0, gt=0, le=HARD_MAX_RISK_PER_TRADE_PCT)
    drawdown_brake_risk_pct: float = Field(default=0.5, gt=0, le=HARD_MAX_RISK_PER_TRADE_PCT)
    drawdown_brake_trigger_pct: float = Field(default=8.0, gt=0, le=50)
    max_position_pct: float = Field(default=10.0, gt=0, le=HARD_MAX_POSITION_PCT)
    max_open_positions: int = Field(default=5, ge=1, le=10)
    atr_stop_multiple: float = Field(default=2.0, gt=0, le=5)
    target_r_multiple: float = Field(default=2.0, gt=0, le=10)
    cooloff_after_losses: int = Field(default=2, ge=1, le=10)
    cooloff_trading_days: int = Field(default=3, ge=1, le=30)
    earnings_exclusion_trading_days: int = Field(default=7, ge=0, le=30)
    atr_pct_warn: float = Field(default=4.0, gt=0, le=50)
    atr_pct_ceiling: float = Field(default=6.0, gt=0, le=50)

    @model_validator(mode="after")
    def _ordering(self) -> SwingRiskConfig:
        if self.drawdown_brake_risk_pct > self.risk_per_trade_pct:
            raise ValueError("drawdown_brake_risk_pct must not exceed risk_per_trade_pct")
        if self.atr_pct_warn >= self.atr_pct_ceiling:
            raise ValueError("atr_pct_warn must be below atr_pct_ceiling")
        return self


class GrowthRiskConfig(_Frozen):
    max_holdings: int = Field(default=6, ge=1, le=20)
    max_position_pct: float = Field(default=8.0, gt=0, le=HARD_MAX_POSITION_PCT)


class PortfolioRiskConfig(_Frozen):
    max_sector_pct: float = Field(default=30.0, gt=0, le=HARD_MAX_SECTOR_PCT)


class UniverseConfig(_Frozen):
    include_sp500: bool = True
    etfs: tuple[str, ...] = ("SPY", "VTI", "VOO", "SCHD", "VIG", "QQQ", "IWM", "VXUS", "BND")
    min_price: float = Field(default=10.0, ge=0)
    min_avg_dollar_volume: float = Field(default=20_000_000.0, ge=0)
    avg_volume_days: int = Field(default=20, ge=5, le=250)


class RegimeConfig(_Frozen):
    benchmark: str = "SPY"
    vix_yellow: float = Field(default=20.0, gt=0)
    vix_red: float = Field(default=30.0, gt=0)
    breadth_yellow_pct: Pct = 50.0
    breadth_red_pct: Pct = 30.0

    @model_validator(mode="after")
    def _ordering(self) -> RegimeConfig:
        if self.vix_yellow >= self.vix_red:
            raise ValueError("vix_yellow must be below vix_red")
        if self.breadth_red_pct >= self.breadth_yellow_pct:
            raise ValueError("breadth_red_pct must be below breadth_yellow_pct")
        return self


class DataConfig(_Frozen):
    price_provider: str = "yfinance"
    macro_provider: str = "fred_csv"
    history_years: int = Field(default=12, ge=1, le=40)
    # Max requests per second we allow ourselves per provider (self-imposed, below any limit).
    max_requests_per_second: float = Field(default=1.0, gt=0, le=10)


class AppConfig(_Frozen):
    account: AccountConfig = AccountConfig()
    swing: SwingRiskConfig = SwingRiskConfig()
    growth: GrowthRiskConfig = GrowthRiskConfig()
    portfolio: PortfolioRiskConfig = PortfolioRiskConfig()
    universe: UniverseConfig = UniverseConfig()
    regime: RegimeConfig = RegimeConfig()
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

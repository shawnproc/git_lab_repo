from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import ValidationError
from sqlalchemy import select

from keystone_ledger.config import AppConfig, diff_configs, load_config
from keystone_ledger.core.config_audit import record_config
from keystone_ledger.db.models import ConfigAudit
from keystone_ledger.db.session import init_schema, make_engine, make_session_factory, transaction


def test_defaults_match_spec() -> None:
    c = AppConfig()
    assert c.account.starting_equity == 10_000
    assert (c.account.sleeves.core_pct, c.account.sleeves.swing_pct) == (50, 25)
    assert c.swing.risk_per_trade_pct == 1.0
    assert c.swing.max_position_pct == 10.0
    assert c.swing.max_open_positions == 5
    assert c.growth.max_holdings == 6
    assert c.growth.max_position_pct == 8.0
    assert c.portfolio.max_sector_pct == 30.0


@pytest.mark.parametrize(
    "override",
    [
        {"swing": {"risk_per_trade_pct": 1.01}},
        {"swing": {"risk_per_trade_pct": 0}},
        {"swing": {"max_position_pct": 25}},
        {"portfolio": {"max_sector_pct": 50}},
        {"account": {"sleeves": {"core_pct": 60, "swing_pct": 25, "growth_pct": 25}}},
        {"swing": {"drawdown_brake_risk_pct": 1.0, "risk_per_trade_pct": 0.5}},
        {"swing": {"atr_pct_warn": 7, "atr_pct_ceiling": 6}},
        {"regime": {"vix_yellow": 35}},
        {"unknown_section": {}},
        {"swing": {"typo_field": 1}},
    ],
)
def test_invalid_configs_refuse_to_load(override: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        AppConfig.model_validate(override)


def test_config_is_immutable() -> None:
    c = AppConfig()
    with pytest.raises(ValidationError):
        c.swing.risk_per_trade_pct = 5  # type: ignore[misc]


def test_load_toml(tmp_path: Path) -> None:
    p = tmp_path / "k.toml"
    p.write_text("[account]\nstarting_equity = 25000\n[swing]\nrisk_per_trade_pct = 0.75\n")
    c = load_config(p)
    assert c.account.starting_equity == 25000
    assert c.swing.risk_per_trade_pct == 0.75
    assert load_config(tmp_path / "missing.toml") == AppConfig()


def test_diff_configs() -> None:
    assert diff_configs({"a": {"b": 1, "c": 2}}, {"a": {"b": 1, "c": 3}}) == {"a.c": [2, 3]}


def test_config_changes_are_audited() -> None:
    engine = make_engine(None)
    init_schema(engine)
    sf = make_session_factory(engine)
    with transaction(sf) as s:
        assert record_config(s, AppConfig()) == {}
    with transaction(sf) as s:
        assert record_config(s, AppConfig()) is None  # unchanged -> no row
    changed = AppConfig.model_validate(
        {"swing": {"risk_per_trade_pct": 0.5, "drawdown_brake_risk_pct": 0.25}}
    )
    with transaction(sf) as s:
        diff = record_config(s, changed)
    assert diff == {
        "swing.risk_per_trade_pct": [1.0, 0.5],
        "swing.drawdown_brake_risk_pct": [0.5, 0.25],
    }
    with sf() as s:
        rows = s.scalars(select(ConfigAudit).order_by(ConfigAudit.id)).all()
    assert len(rows) == 2
    assert json.loads(rows[1].diff_json)["swing.risk_per_trade_pct"] == [1.0, 0.5]


def test_example_config_matches_defaults() -> None:
    example = Path(__file__).resolve().parents[2] / "config" / "keystone.example.toml"
    assert load_config(example) == AppConfig()

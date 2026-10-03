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
    assert (c.plan.core_pct, c.plan.stocks_pct) == (60, 40)
    assert [(f.symbol, f.weight_pct) for f in c.plan.core_funds] == [("VTI", 45), ("VXUS", 15)]
    assert c.plan.max_stocks == 6
    assert len(c.plan.candidates) == 40
    assert (c.drift.max_abs_pp, c.drift.max_relative_pct) == (5, 25)
    assert c.contribution.fractional_shares is True
    assert c.mood.index == "^GSPC"
    assert c.mood.ma_days == 200


@pytest.mark.parametrize(
    "override",
    [
        {"plan": {"core_pct": 70, "stocks_pct": 40}},
        {"plan": {"core_pct": 50, "stocks_pct": 50}},  # core funds still sum to 60
        {"plan": {"max_single_stock_pct": 15}},  # hard ceiling is 10%
        {"plan": {"max_stocks": 11}},
        {
            "plan": {
                "core_funds": [
                    {"symbol": s, "weight_pct": 15} for s in ("VTI", "VXUS", "VOO", "SCHD")
                ]
            }
        },
        {"plan": {"core_funds": [{"symbol": "VTI", "weight_pct": 60}], "candidates": {"VTI": "x"}}},
        {"plan": {"candidates": {"BAD SYM": "Tech"}}},
        {"plan": {"candidates": {f"S{i}": "Tech" for i in range(61)}}},
        {"mood": {"vix_green_below": 35}},
        {"drift": {"max_abs_pp": 0}},
        {"screen": {"typo_field": 1}},
        {"swing": {}},  # removed section
    ],
)
def test_invalid_configs_refuse_to_load(override: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        AppConfig.model_validate(override)


def test_config_is_immutable() -> None:
    c = AppConfig()
    with pytest.raises(ValidationError):
        c.plan.max_stocks = 9  # type: ignore[misc]


def test_load_toml(tmp_path: Path) -> None:
    p = tmp_path / "k.toml"
    p.write_text(
        "[plan]\ncore_pct = 70.0\nstocks_pct = 30.0\n"
        "core_funds = [{symbol = 'VTI', weight_pct = 50.0}, {symbol = 'BND', weight_pct = 20.0}]\n"
        "[contribution]\nfractional_shares = false\n"
    )
    c = load_config(p)
    assert c.plan.core_funds[1].symbol == "BND"
    assert c.contribution.fractional_shares is False
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
    changed = AppConfig.model_validate({"drift": {"max_abs_pp": 3.0}})
    with transaction(sf) as s:
        diff = record_config(s, changed)
    assert diff == {"drift.max_abs_pp": [5.0, 3.0]}
    with sf() as s:
        rows = s.scalars(select(ConfigAudit).order_by(ConfigAudit.id)).all()
    assert len(rows) == 2
    assert json.loads(rows[1].diff_json) == {"drift.max_abs_pp": [5.0, 3.0]}


def test_example_config_matches_defaults() -> None:
    example = Path(__file__).resolve().parents[2] / "config" / "keystone.example.toml"
    assert load_config(example) == AppConfig()

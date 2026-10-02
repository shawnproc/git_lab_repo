"""Record every change to the effective trading config."""

from __future__ import annotations

import json
import logging
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from keystone_ledger.config import AppConfig, diff_configs
from keystone_ledger.core.auth import Clock, utcnow
from keystone_ledger.db.models import ConfigAudit

log = logging.getLogger(__name__)


def record_config(s: Session, cfg: AppConfig, clock: Clock = utcnow) -> dict[str, Any] | None:
    """Append an audit row if the config differs from the last recorded one.

    Returns the diff (empty dict on first run) when a row was written, else None.
    """
    last = s.scalar(select(ConfigAudit).order_by(ConfigAudit.id.desc()).limit(1))
    fp = cfg.fingerprint()
    if last is not None and last.fingerprint == fp:
        return None
    new = cfg.model_dump(mode="json")
    diff = diff_configs(json.loads(last.config_json), new) if last is not None else {}
    s.add(
        ConfigAudit(
            at=clock(),
            fingerprint=fp,
            source="startup",
            config_json=cfg.canonical_json(),
            diff_json=json.dumps(diff, sort_keys=True),
        )
    )
    if last is None:
        log.info("config: initial config recorded (%s)", fp[:12])
    else:
        log.warning("config: changed since last start: %s", ", ".join(sorted(diff)))
    return diff

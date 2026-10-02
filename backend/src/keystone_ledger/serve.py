"""Entry point: `python -m keystone_ledger.serve` (or `make run`)."""

from __future__ import annotations

import logging
import os
import sys

import uvicorn

from keystone_ledger.app import build_state, create_app
from keystone_ledger.core.auth import ensure_setup_token
from keystone_ledger.core.logging import configure_logging
from keystone_ledger.db.models import User
from keystone_ledger.settings import get_settings

log = logging.getLogger("keystone_ledger")


def main() -> int:
    # Everything we create (DB, WAL, setup token) is owner-only: it holds the password hash.
    os.umask(0o077)
    configure_logging()
    settings = get_settings()
    if not settings.is_loopback and not settings.allow_non_loopback:
        log.error(
            "refusing to bind %s: only loopback is allowed. For phone access use Tailscale "
            "(see README) rather than exposing a port.",
            settings.host,
        )
        return 2
    state = build_state(settings)
    with state.session_factory() as s:
        has_user = s.query(User.id).first() is not None
    if not has_user:
        token = ensure_setup_token(settings.setup_token_path)
        # Printed once to the local console only; also stored 0600 in var/setup-token.txt.
        print(
            f"\n  First run: open http://{settings.host}:{settings.port}/ and enter setup token:\n"
            f"      {token}\n",
            file=sys.stderr,
            flush=True,
        )
    app = create_app(state)
    uvicorn.run(
        app,
        host=settings.host,
        port=settings.port,
        log_config=None,
        server_header=False,
        date_header=False,
        proxy_headers=False,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

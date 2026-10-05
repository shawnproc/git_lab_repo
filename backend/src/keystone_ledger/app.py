"""Application factory."""

from __future__ import annotations

import logging
from collections.abc import Callable
from datetime import timedelta
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy.orm import Session, sessionmaker

from keystone_ledger import __version__
from keystone_ledger.api import (
    routes_auth,
    routes_market,
    routes_plan,
    routes_research,
    routes_wall,
)
from keystone_ledger.api.deps import AppState
from keystone_ledger.api.security import SecurityMiddleware
from keystone_ledger.config import AppConfig, load_config
from keystone_ledger.core.auth import AuthPolicy, AuthService, Clock, utcnow
from keystone_ledger.core.config_audit import record_config
from keystone_ledger.core.logging import configure_logging
from keystone_ledger.data.calendar import MarketCalendar
from keystone_ledger.data.fundamentals import FundamentalsService
from keystone_ledger.data.registry import (
    build_fundamentals_provider,
    build_macro_provider,
    build_price_provider,
)
from keystone_ledger.data.research_feed import ResearchFeed
from keystone_ledger.data.service import MarketDataService
from keystone_ledger.db.session import init_schema, make_engine, make_session_factory, transaction
from keystone_ledger.planner import Planner
from keystone_ledger.settings import REPO_ROOT, Settings, get_settings

log = logging.getLogger(__name__)

FRONTEND_DIST = REPO_ROOT / "frontend" / "dist"


def build_state(
    settings: Settings,
    config: AppConfig | None = None,
    *,
    in_memory: bool = False,
    clock: Clock = utcnow,
    market_factory: Callable[[sessionmaker[Session]], MarketDataService] | None = None,
    fundamentals_factory: Callable[[sessionmaker[Session]], FundamentalsService] | None = None,
    research: ResearchFeed | None = None,
) -> AppState:
    cfg = config if config is not None else load_config(settings.config_path)
    engine = make_engine(None if in_memory else settings.db_path)
    init_schema(engine)
    sf = make_session_factory(engine)
    with transaction(sf) as s:
        record_config(s, cfg, clock)
    policy = AuthPolicy(
        idle=timedelta(hours=settings.session_idle_hours),
        absolute=timedelta(days=settings.session_absolute_days),
        max_failures=settings.login_max_failures,
        window=timedelta(minutes=settings.login_window_minutes),
        lockout=timedelta(minutes=settings.login_lockout_minutes),
    )
    if market_factory is not None:
        market = market_factory(sf)
    else:
        market = MarketDataService(
            sf,
            build_price_provider(cfg, settings),
            build_macro_provider(cfg),
            MarketCalendar(),
            history_years=cfg.data.history_years,
            clock=clock,
        )
    if fundamentals_factory is not None:
        fundamentals = fundamentals_factory(sf)
    else:
        fundamentals = FundamentalsService(
            sf,
            build_fundamentals_provider(cfg, settings),
            max_age=timedelta(days=cfg.data.fundamentals_max_age_days),
            clock=clock,
        )
    if research is None:
        cache = None if in_memory else settings.data_dir / "research-cache.json"
        research = ResearchFeed(settings.research_url, cache, clock)
    return AppState(
        settings=settings,
        config=cfg,
        session_factory=sf,
        auth=AuthService(policy, clock),
        market=market,
        fundamentals=fundamentals,
        planner=Planner(cfg, market, fundamentals, research),
        research=research,
    )


def create_app(
    state: AppState | None = None, frontend_dist: Path | None = FRONTEND_DIST
) -> FastAPI:
    if state is None:
        configure_logging()
        state = build_state(get_settings())
    settings = state.settings
    app = FastAPI(
        title="Keystone Ledger",
        version=__version__,
        # No public schema/docs UI: smaller surface, and Swagger UI would need a looser CSP.
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.state.kl = state
    app.add_middleware(
        SecurityMiddleware,
        allowed_hosts=settings.allowed_hosts,
        allowed_origins=settings.allowed_origins,
        max_body_bytes=settings.max_body_bytes,
        hsts=settings.https,
    )
    app.include_router(routes_auth.router)
    app.include_router(routes_market.router)
    app.include_router(routes_plan.router)
    app.include_router(routes_wall.router)
    app.include_router(routes_research.router)

    if frontend_dist is not None and (frontend_dist / "index.html").is_file():
        app.mount("/assets", StaticFiles(directory=frontend_dist / "assets"), name="assets")
        index = frontend_dist / "index.html"

        @app.get("/{path:path}", include_in_schema=False)
        def spa(path: str) -> FileResponse:
            # Single-page app: every non-API path serves index.html (no filesystem lookups).
            if path == "api" or path.startswith("api/"):
                raise HTTPException(404, "not found")
            return FileResponse(index, headers={"cache-control": "no-cache"})

    return app

"""Glue between cached data and the pure engine. Reads caches only; never calls providers
unless a function name says `refresh`."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

import pandas as pd
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from keystone_ledger.config import AppConfig
from keystone_ledger.core.mood import MoodResult, market_mood
from keystone_ledger.core.plan import (
    ContributionPlan,
    DriftRow,
    PortfolioSummary,
    Quote,
    Target,
    build_targets,
    drift,
    split_contribution,
    value_portfolio,
)
from keystone_ledger.core.screen import Candidate, ScreenResult, screen
from keystone_ledger.data.fundamentals import FundamentalsService, FundamentalsStatus
from keystone_ledger.data.research_feed import ResearchFeed
from keystone_ledger.data.service import Freshness, MarketDataService
from keystone_ledger.db.models import Holding, SecurityEvent, WatchItem

VIX_SERIES = "VIXCLS"
MAX_INCLUDED = 5  # Search picks in buy days, same as the phone
SEARCH_WHY = "Your pick from Search. It passes every quality check."


@dataclass(frozen=True)
class PlanView:
    targets: list[Target]
    screen: list[ScreenResult]
    fundamentals: FundamentalsStatus
    basis_value: float
    basis_is_reference: bool


@dataclass(frozen=True)
class PortfolioView:
    summary: PortfolioSummary
    freshness: dict[str, Freshness]


def run_screen(
    cfg: AppConfig, fundamentals: FundamentalsService, keep: list[str] | None = None
) -> list[ScreenResult]:
    """Screen every configured candidate using cached SEC facts (no provider calls).
    `keep`: earlier picks that stay picked unless replaced (see core/watch.py)."""
    cands = cfg.plan.candidates
    symbols = list(cands)
    facts = fundamentals.facts(symbols)
    names = fundamentals.company_names(symbols)
    candidates = [
        Candidate(
            sym,
            sector,
            names.get(sym, sym),
            facts.get(sym, {}),
            note="" if sym in facts else "no SEC filer found for this ticker",
        )
        for sym, sector in cands.items()
    ]
    return screen(
        candidates,
        fundamentals.years(),
        cfg.screen,
        cfg.plan.max_stocks,
        cfg.plan.max_per_sector,
        keep=keep or (),
    )


class Planner:
    def __init__(
        self,
        cfg: AppConfig,
        market: MarketDataService,
        fundamentals: FundamentalsService,
        research: ResearchFeed | None = None,
    ) -> None:
        self.cfg = cfg
        self.market = market
        self.fundamentals = fundamentals
        self.research = research

    # --- Search picks -------------------------------------------------------------------------

    def included(self, s: Session) -> list[str]:
        """Watchlist picks switched on for buy days that are a "Good fit" in the current search
        data. Without search data, none: never on an old verdict."""
        if self.research is None or self.research.data() is None:
            return []
        rows = s.scalars(select(WatchItem).where(WatchItem.include).order_by(WatchItem.symbol))
        out = []
        for w in rows:
            c = self.research.company(w.symbol)
            if c is not None and c.get("v") == "fit":
                out.append(w.symbol)
        return out[:MAX_INCLUDED]

    # --- holdings -----------------------------------------------------------------------------

    @staticmethod
    def holdings(s: Session) -> list[tuple[str, float, float]]:
        rows = s.scalars(select(Holding).order_by(Holding.symbol)).all()
        return [(h.symbol, h.shares, h.avg_cost) for h in rows]

    @staticmethod
    def replace_holdings(s: Session, rows: list[tuple[str, float, float]], now: datetime) -> None:
        s.execute(delete(Holding))
        for sym, shares, cost in rows:
            s.add(Holding(symbol=sym, shares=shares, avg_cost=cost, updated_at=now))
        s.add(SecurityEvent(at=now, kind="holdings_updated", detail=f"count={len(rows)}"))

    # --- symbols --------------------------------------------------------------------------------

    def plan_symbols(self, s: Session) -> list[str]:
        core = [f.symbol for f in self.cfg.plan.core_funds]
        picked = [r.symbol for r in self.screen() if r.picked]
        held = [h[0] for h in self.holdings(s)]
        return list(dict.fromkeys([*core, *picked, *self.included(s), *held]))

    def chartable(self, s: Session) -> set[str]:
        """Symbols the app may fetch on demand: bounded, so a GET can't trigger arbitrary
        provider calls."""
        return {
            self.cfg.mood.index,
            *self.cfg.plan.candidates,
            *(f.symbol for f in self.cfg.plan.core_funds),
            *(h[0] for h in self.holdings(s)),
            *(w for w in s.scalars(select(WatchItem.symbol))),
        }

    # --- market ---------------------------------------------------------------------------------

    def quotes(self, symbols: list[str]) -> tuple[dict[str, Quote], dict[str, Freshness]]:
        quotes: dict[str, Quote] = {}
        fresh: dict[str, Freshness] = {}
        for sym in symbols:
            res = self.market.get_bars(sym, refresh=False)
            fresh[sym] = res.freshness
            if res.bars.empty:
                continue
            closes = res.bars["close"].astype(float)
            prev = float(closes.iloc[-2]) if len(closes) > 1 else None
            quotes[sym] = Quote(float(closes.iloc[-1]), prev, res.bars.index[-1])
        return quotes, fresh

    def mood(self) -> tuple[MoodResult, Freshness, Freshness]:
        idx = self.market.get_bars(self.cfg.mood.index, refresh=False)
        vix = self.market.get_series(VIX_SERIES, refresh=False)
        closes = idx.bars["close"].astype(float) if not idx.bars.empty else pd.Series(dtype=float)
        latest_vix = float(vix.values.iloc[-1]) if not vix.values.empty else None
        return market_mood(closes, latest_vix, self.cfg.mood), idx.freshness, vix.freshness

    def refresh_market(self, s: Session) -> None:
        self.market.refresh_bars(self.cfg.mood.index)
        self.market.refresh_series(VIX_SERIES)
        for sym in self.plan_symbols(s):
            self.market.refresh_bars(sym)

    # --- plan -------------------------------------------------------------------------------------

    def screen(self) -> list[ScreenResult]:
        return run_screen(self.cfg, self.fundamentals)

    def plan(self, s: Session) -> PlanView:
        results = self.screen()
        targets = build_targets(
            self.cfg.plan,
            [(r.symbol, r.why) for r in results if r.picked],
            extra=[(sym, SEARCH_WHY) for sym in self.included(s)],
        )
        quotes, _ = self.quotes([h[0] for h in self.holdings(s)])
        summary = value_portfolio(self.holdings(s), quotes)
        use_ref = summary.value <= 0
        return PlanView(
            targets=targets,
            screen=results,
            fundamentals=self.fundamentals.status(s),
            basis_value=self.cfg.plan.reference_amount if use_ref else summary.value,
            basis_is_reference=use_ref,
        )

    def portfolio(self, s: Session) -> PortfolioView:
        holdings = self.holdings(s)
        quotes, fresh = self.quotes([h[0] for h in holdings])
        return PortfolioView(value_portfolio(holdings, quotes), fresh)

    def drift(self, s: Session) -> tuple[list[DriftRow], PortfolioView, list[Target]]:
        pv = self.portfolio(s)
        targets = self.plan(s).targets
        return drift(targets, pv.summary.positions, pv.summary.value, self.cfg.drift), pv, targets

    def contribution(self, s: Session, amount: float) -> ContributionPlan:
        rows, pv, targets = self.drift(s)
        quotes, _ = self.quotes([t.symbol for t in targets])
        current = {r.symbol: r.actual_value or 0.0 for r in rows}
        return split_contribution(
            amount,
            targets,
            current,
            {sym: q.close for sym, q in quotes.items()},
            self.cfg.contribution.fractional_shares,
            pv.summary.value,
        )

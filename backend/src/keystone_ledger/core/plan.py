"""Target allocation, portfolio valuation, drift flags and contribution split. Pure functions."""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from typing import Literal

from keystone_ledger.config import DriftConfig, PlanConfig

Kind = Literal["core", "stock"]


@dataclass(frozen=True)
class Target:
    symbol: str
    kind: Kind
    target_pct: float
    why: str


def build_targets(plan: PlanConfig, picks: Sequence[tuple[str, str]]) -> list[Target]:
    """Core funds at their configured weights; picked stocks split `stocks_pct` equally.

    Each stock is capped at `max_single_stock_pct`. Whatever the cap (or an empty screen) leaves
    unallocated goes to the core funds in proportion to their weights, so targets always sum
    to 100%.
    """
    stocks = list(picks)[: plan.max_stocks]
    per_stock = min(plan.stocks_pct / len(stocks), plan.max_single_stock_pct) if stocks else 0.0
    leftover = plan.stocks_pct - per_stock * len(stocks)
    # Config guarantees core_pct > 0 (1-3 funds, each with a positive weight).
    out = [
        Target(f.symbol, "core", f.weight_pct + leftover * f.weight_pct / plan.core_pct, f.why)
        for f in plan.core_funds
    ]
    out += [Target(sym, "stock", per_stock, why) for sym, why in stocks]
    return out


@dataclass(frozen=True)
class Quote:
    close: float
    prev_close: float | None
    day: date


@dataclass(frozen=True)
class Position:
    symbol: str
    shares: float
    avg_cost: float
    price: float | None
    value: float | None
    day_change: float | None
    cost_basis: float


@dataclass(frozen=True)
class PortfolioSummary:
    positions: list[Position]
    value: float
    cost_basis: float
    day_change: float
    day_change_pct: float | None
    total_change: float
    total_change_pct: float | None
    missing_prices: list[str]


def value_portfolio(
    holdings: Sequence[tuple[str, float, float]], quotes: Mapping[str, Quote]
) -> PortfolioSummary:
    """Totals only include positions with a fetched price; others are listed in `missing_prices`."""
    positions: list[Position] = []
    missing: list[str] = []
    value = cost = day = prev_value = 0.0
    for sym, shares, avg_cost in holdings:
        q = quotes.get(sym)
        basis = shares * avg_cost
        if q is None:
            missing.append(sym)
            positions.append(Position(sym, shares, avg_cost, None, None, None, basis))
            continue
        v = shares * q.close
        dc = shares * (q.close - q.prev_close) if q.prev_close is not None else None
        positions.append(Position(sym, shares, avg_cost, q.close, v, dc, basis))
        value += v
        cost += basis
        if dc is not None:
            day += dc
            prev_value += v - dc
    return PortfolioSummary(
        positions=positions,
        value=value,
        cost_basis=cost,
        day_change=day,
        day_change_pct=day / prev_value * 100 if prev_value > 0 else None,
        total_change=value - cost,
        total_change_pct=(value - cost) / cost * 100 if cost > 0 else None,
        missing_prices=missing,
    )


@dataclass(frozen=True)
class DriftRow:
    symbol: str
    kind: Kind | Literal["off_plan"]
    target_pct: float
    actual_pct: float | None
    diff_pp: float | None
    target_value: float
    actual_value: float | None
    flagged: bool
    reason: str


def drift(
    targets: Sequence[Target],
    positions: Sequence[Position],
    total_value: float,
    cfg: DriftConfig,
) -> list[DriftRow]:
    by_sym = {p.symbol: p for p in positions}
    rows: list[DriftRow] = []
    target_syms = {t.symbol for t in targets}
    for t in targets:
        p = by_sym.get(t.symbol)
        actual_value = 0.0 if p is None else p.value
        target_value = t.target_pct / 100 * total_value
        if actual_value is None or total_value <= 0:
            rows.append(
                DriftRow(t.symbol, t.kind, t.target_pct, None, None, target_value, actual_value,
                         False, "price unavailable" if actual_value is None else "")
            )  # fmt: skip
            continue
        actual_pct = actual_value / total_value * 100
        diff = actual_pct - t.target_pct
        rel = abs(diff) / t.target_pct * 100 if t.target_pct > 0 else 0.0
        off_abs = abs(diff) > cfg.max_abs_pp
        off_rel = rel > cfg.max_relative_pct
        reason = ""
        if actual_value == 0:
            reason = "you don't own any yet"
        elif off_abs or off_rel:
            side = "above" if diff > 0 else "below"
            more = "more" if diff > 0 else "less"
            reason = f"{abs(diff):.1f} percentage points {side} its target"
            if off_rel:
                reason += f" (about {rel:.0f}% {more} than planned)"
        rows.append(
            DriftRow(t.symbol, t.kind, t.target_pct, actual_pct, diff, target_value,
                     actual_value, off_abs or off_rel, reason)
        )  # fmt: skip
    for p in positions:
        if p.symbol in target_syms:
            continue
        pct = p.value / total_value * 100 if p.value is not None and total_value > 0 else None
        rows.append(
            DriftRow(p.symbol, "off_plan", 0.0, pct, pct, 0.0, p.value, True,
                     "not part of your plan (that's okay; it just isn't counted toward a target)")
        )  # fmt: skip
    return rows


@dataclass(frozen=True)
class Allocation:
    symbol: str
    amount: float
    shares: float | None  # None when the price is unavailable
    price: float | None


@dataclass(frozen=True)
class ContributionPlan:
    amount: float
    allocations: list[Allocation]
    leftover: float
    note: str


def split_contribution(
    amount: float,
    targets: Sequence[Target],
    current_values: Mapping[str, float],
    prices: Mapping[str, float],
    fractional: bool,
    total_value: float,
) -> ContributionPlan:
    """Send new money to whatever is furthest below target. Never suggests selling.

    `total_value` includes off-plan holdings (they dilute every target but get no new money).
    Fractional: dollars are exact. Whole shares: floor each, then spend what's left one share at
    a time on the most underweight affordable holding.
    """
    if amount <= 0 or not targets:
        return ContributionPlan(amount, [], amount, "")
    new_total = total_value + amount
    deficits = {
        t.symbol: max(0.0, t.target_pct / 100 * new_total - current_values.get(t.symbol, 0.0))
        for t in targets
    }
    total_def = sum(deficits.values())
    dollars: dict[str, float] = {}
    if total_def >= amount:
        dollars = {s: amount * d / total_def for s, d in deficits.items()}
    else:
        rest = amount - total_def
        weight_sum = sum(t.target_pct for t in targets)
        dollars = {t.symbol: deficits[t.symbol] + rest * t.target_pct / weight_sum for t in targets}

    unpriced = [s for s, d in dollars.items() if d > 0 and s not in prices]
    if fractional:
        allocs = [
            Allocation(s, round(d, 2), round(d / prices[s], 4) if s in prices else None,
                       prices.get(s))
            for s, d in dollars.items() if d >= 0.005
        ]  # fmt: skip
        spent = sum(a.amount for a in allocs)
        note = (
            f"No current price for {', '.join(unpriced)} yet, so share counts aren't shown. "
            'Click "Refresh prices" first.'
            if unpriced
            else ""
        )
        return ContributionPlan(amount, allocs, round(amount - spent, 2), note)

    shares = {s: math.floor(d / prices[s]) for s, d in dollars.items() if s in prices}
    left = amount - sum(n * prices[s] for s, n in shares.items())
    held = dict(current_values)
    for s, n in shares.items():
        held[s] = held.get(s, 0.0) + n * prices[s]
    target_pct = {t.symbol: t.target_pct for t in targets}
    while True:
        affordable = [s for s in shares if prices[s] <= left + 1e-9]
        if not affordable:
            break
        s = min(affordable, key=lambda x: held.get(x, 0.0) / new_total * 100 - target_pct[x])
        shares[s] += 1
        held[s] = held.get(s, 0.0) + prices[s]
        left -= prices[s]
    allocs = [
        Allocation(s, round(n * prices[s], 2), float(n), prices[s])
        for s, n in shares.items() if n > 0
    ]  # fmt: skip
    note = "Whole shares only, so a little cash is left over. Keep it for next month."
    if unpriced:
        note += f" No current price for {', '.join(unpriced)} yet, so nothing goes there."
    return ContributionPlan(amount, allocs, round(left, 2), note)

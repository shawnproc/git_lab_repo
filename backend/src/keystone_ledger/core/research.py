"""Search verdicts: does a company fit the plan's rules? Pure: built only from the screen result
(SEC filings) and the price check. A verdict says how a company measures up against the same
tests used for the plan; it is not a prediction and never tells anyone to buy or sell.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from keystone_ledger.config import ScreenConfig
from keystone_ledger.core.screen import ScreenResult
from keystone_ledger.core.valuation import Valuation

Verdict = Literal["fit", "pricey", "no", "unknown"]

VERDICT_WORDS: dict[Verdict, str] = {
    "fit": "Good fit",
    "pricey": "Good business, pricey right now",
    "no": "Not a fit",
    "unknown": "Not enough data to judge",
}


@dataclass(frozen=True)
class Judgement:
    verdict: Verdict
    headline: str  # one plain sentence


def judge(r: ScreenResult, v: Valuation | None, cfg: ScreenConfig) -> Judgement:
    if r.metrics.latest_year is None:
        return Judgement("unknown", "Its SEC reports don't include sales numbers we can read, "
                                    "so there's nothing fair to judge it on.")  # fmt: skip
    failed = [c for c in r.checks if c.status == "fail"]
    if failed:
        names = "; ".join(c.label.rstrip("?:") for c in failed)
        n = len(failed)
        return Judgement("no", f"On its latest yearly report it misses {n} of the plan's 5 checks "
                               f"({names}), so it doesn't fit the plan's rules.")  # fmt: skip
    missing = sum(c.status == "unavailable" for c in r.checks)
    if missing > cfg.max_unavailable or r.score is None:
        return Judgement("unknown", f"{missing} of the 5 checks can't be run from its reports, "
                                    "too many to judge fairly.")  # fmt: skip
    if v is not None and v.flagged:
        pricey = (
            "It passes every quality check, but its price is well above its usual level "
            "compared to its profits. Worth watching."
        )
        return Judgement("pricey", pricey)
    price = "" if v is None or v.pe is None else " and its price looks normal for it"
    return Judgement("fit", f"It passes every quality check{price}.")

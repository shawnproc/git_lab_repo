"""Parsers for SEC EDGAR filings: the daily master index, insider Form 4s and 8-K headers.

Everything here reads untrusted text from the SEC. XML goes through `defusedxml` (no entity
expansion or external fetches), every field is bounded and validated, and anything that doesn't
parse is skipped, never guessed.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from datetime import date
from xml.etree.ElementTree import Element

from defusedxml import ElementTree as SafeET
from defusedxml.common import DefusedXmlException

from keystone_ledger.data.sec_provider import ARCHIVES

INDEX_URL = ARCHIVES + "daily-index/{y}/QTR{q}/master.{ymd}.idx"
_FILE = re.compile(r"^edgar/data/\d{1,10}/[\d-]{20}\.txt$")
# Open-market purchases and sales: the trades insiders choose to make with their own money.
CODES = {"P": "buy", "S": "sell"}


@dataclass(frozen=True)
class IndexRow:
    cik: int
    form: str
    filed: date
    path: str  # relative to ARCHIVES' parent ("edgar/data/...txt")


def index_url(day: date) -> str:
    return INDEX_URL.format(y=day.year, q=(day.month - 1) // 3 + 1, ymd=day.strftime("%Y%m%d"))


def filing_url(path: str) -> str:
    return ARCHIVES[: -len("edgar/")] + path


def parse_master_index(text: str, forms: frozenset[str]) -> list[IndexRow]:
    """`CIK|Company Name|Form Type|Date Filed|Filename` rows after the dashed header line."""
    out: list[IndexRow] = []
    started = False
    for line in text.splitlines():
        if not started:
            started = line.startswith("-----")
            continue
        parts = line.split("|")
        if len(parts) != 5 or parts[2] not in forms or not _FILE.fullmatch(parts[4]):
            continue
        try:
            cik = int(parts[0])
            filed = date(int(parts[3][:4]), int(parts[3][4:6]), int(parts[3][6:8]))
        except ValueError:
            continue
        if 0 < cik < 10**10:
            out.append(IndexRow(cik, parts[2], filed, parts[4]))
    return out


@dataclass(frozen=True)
class InsiderTrade:
    day: date
    owner: str
    role: str  # "CEO", "Director", "10% owner", ...
    code: str  # "P" (bought) or "S" (sold)
    shares: float
    value: float  # dollars
    planned: bool  # made under a pre-set 10b5-1 trading plan


def _text(el: Element | None, path: str) -> str:
    if el is None:
        return ""
    found = el.find(path)
    return (found.text or "").strip() if found is not None and found.text else ""


def _num(el: Element, path: str) -> float | None:
    try:
        v = float(_text(el, path))
    except ValueError:
        return None
    return v if math.isfinite(v) and 0 <= v < 1e13 else None


def _yes(v: str) -> bool:
    return v.strip().lower() in ("1", "true")


def _role(owner: Element) -> str:
    rel = owner.find("reportingOwnerRelationship")
    roles: list[str] = []
    title = _text(rel, "officerTitle")[:40]
    if rel is not None and _yes(_text(rel, "isOfficer")):
        roles.append(title or "Officer")
    if rel is not None and _yes(_text(rel, "isDirector")):
        roles.append("Director")
    if rel is not None and _yes(_text(rel, "isTenPercentOwner")):
        roles.append("10% owner")
    return ", ".join(roles) or "Insider"


def _ownership_doc(text: str, issuer_cik: int) -> Element | None:
    """The Form 4's XML, only if it's about this company (not a filer row for the insider)."""
    start, end = text.find("<XML>"), text.find("</XML>")
    if start < 0 or end < start:
        return None
    try:
        root = SafeET.fromstring(text[start + 5 : end].strip())
        issuer = int(_text(root, "issuer/issuerCik"))
    except (SafeET.ParseError, DefusedXmlException, ValueError):
        return None
    return root if root.tag == "ownershipDocument" and issuer == issuer_cik else None


def parse_form4(text: str, issuer_cik: int) -> list[InsiderTrade]:
    """Open-market buys and sells in one Form 4, one row per code (shares and dollars summed)."""
    root = _ownership_doc(text, issuer_cik)
    if root is None:
        return []
    owner = root.find("reportingOwner")
    if owner is None:
        return []
    name = re.sub(r"\s+", " ", _text(owner, "reportingOwnerId/rptOwnerName"))[:60]
    planned = _yes(_text(root, "aff10b5One"))
    totals: dict[tuple[date, str], list[float]] = {}
    for tx in root.iterfind("nonDerivativeTable/nonDerivativeTransaction"):
        code = _text(tx, "transactionCoding/transactionCode")
        if code not in CODES:
            continue
        shares = _num(tx, "transactionAmounts/transactionShares/value")
        price = _num(tx, "transactionAmounts/transactionPricePerShare/value")
        try:
            day = date.fromisoformat(_text(tx, "transactionDate/value")[:10])
        except ValueError:
            continue
        if not shares or price is None:
            continue
        t = totals.setdefault((day, code), [0.0, 0.0])
        t[0] += shares
        t[1] += shares * price
    return [
        InsiderTrade(day, name, _role(owner), code, round(s, 4), round(v, 2), planned)
        for (day, code), (s, v) in sorted(totals.items())
    ]


# 8-K "items": what kind of news the company had to announce. Matched on the SEC's own wording.
ITEMS: tuple[tuple[str, str], ...] = (
    ("1.01", "entry into a material definitive agreement"),
    ("1.02", "termination of a material definitive agreement"),
    ("1.03", "bankruptcy or receivership"),
    ("1.05", "material cybersecurity incidents"),
    ("2.01", "completion of acquisition or disposition of assets"),
    ("2.02", "results of operations and financial condition"),
    ("2.03", "creation of a direct financial obligation"),
    ("2.04", "triggering events that accelerate or increase"),
    ("2.05", "costs associated with exit or disposal activities"),
    ("2.06", "material impairments"),
    ("3.01", "notice of delisting or failure to satisfy"),
    ("3.02", "unregistered sales of equity securities"),
    ("3.03", "material modification to rights of security holders"),
    ("4.01", "changes in registrant's certifying accountant"),
    ("4.02", "non-reliance on previously issued financial statements"),
    ("5.01", "changes in control of registrant"),
    ("5.02", "departure of directors or certain officers"),
    ("5.03", "amendments to articles of incorporation or bylaws"),
    ("5.07", "submission of matters to a vote of security holders"),
    ("7.01", "regulation fd disclosure"),
    ("8.01", "other events"),
)


def parse_8k_items(header: str) -> list[str]:
    """Item codes from an 8-K's SEC header ("ITEM INFORMATION:" lines). Exhibits-only (9.01) and
    unknown wording are left out."""
    out: list[str] = []
    for line in header.splitlines():
        if not line.startswith("ITEM INFORMATION:"):
            continue
        words = line.split(":", 1)[1].strip().lower().replace(chr(0x2019), "'")
        for code, start in ITEMS:
            if words.startswith(start) and code not in out:
                out.append(code)
    return out

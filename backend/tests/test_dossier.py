from __future__ import annotations

from datetime import UTC, date, datetime
from typing import Any

from keystone_ledger.data.base import RateLimitedError
from keystone_ledger.data.edgar_filings import (
    index_url,
    parse_8k_items,
    parse_form4,
    parse_master_index,
)
from keystone_ledger.tools.dossier import build_dossier, validate_dossier

INDEX = """Description:           Master Index of EDGAR Dissemination Feed
Last Data Received:    October 12, 2026

CIK|Company Name|Form Type|Date Filed|Filename
--------------------------------------------------------------------------------
320193|Apple Inc.|4|20261012|edgar/data/320193/0001140361-26-000001.txt
1999999|Cook Timothy D|4|20261012|edgar/data/320193/0001140361-26-000001.txt
320193|Apple Inc.|8-K|20261012|edgar/data/320193/0000320193-26-000077.txt
789019|MICROSOFT CORP|10-Q|20261012|edgar/data/789019/0000789019-26-000050.txt
bad|row|4|20261012|edgar/data/1/x.txt
"""


def form4(issuer: int = 320193, code: str = "P", shares: str = "1000", price: str = "150.50",
          plan: str = "0", officer: str = "Chief Executive Officer") -> str:  # fmt: skip
    return f"""<SEC-DOCUMENT>
<SEC-HEADER>ACCESSION NUMBER: 0001140361-26-000001</SEC-HEADER>
<DOCUMENT><TYPE>4<TEXT>
<XML>
<?xml version="1.0"?>
<ownershipDocument>
  <aff10b5One>{plan}</aff10b5One>
  <issuer><issuerCik>{issuer:010d}</issuerCik><issuerTradingSymbol>AAPL</issuerTradingSymbol></issuer>
  <reportingOwner>
    <reportingOwnerId><rptOwnerName>Cook   Timothy D</rptOwnerName></reportingOwnerId>
    <reportingOwnerRelationship><isDirector>1</isDirector><isOfficer>true</isOfficer>
      <officerTitle>{officer}</officerTitle></reportingOwnerRelationship>
  </reportingOwner>
  <nonDerivativeTable>
    <nonDerivativeTransaction>
      <transactionDate><value>2026-10-09</value></transactionDate>
      <transactionCoding><transactionCode>{code}</transactionCode></transactionCoding>
      <transactionAmounts><transactionShares><value>{shares}</value></transactionShares>
        <transactionPricePerShare><value>{price}</value></transactionPricePerShare></transactionAmounts>
    </nonDerivativeTransaction>
    <nonDerivativeTransaction>
      <transactionDate><value>2026-10-09</value></transactionDate>
      <transactionCoding><transactionCode>{code}</transactionCode></transactionCoding>
      <transactionAmounts><transactionShares><value>500</value></transactionShares>
        <transactionPricePerShare><value>151</value></transactionPricePerShare></transactionAmounts>
    </nonDerivativeTransaction>
    <nonDerivativeTransaction>
      <transactionDate><value>2026-10-09</value></transactionDate>
      <transactionCoding><transactionCode>M</transactionCode></transactionCoding>
      <transactionAmounts><transactionShares><value>9999</value></transactionShares>
        <transactionPricePerShare><value>0</value></transactionPricePerShare></transactionAmounts>
    </nonDerivativeTransaction>
  </nonDerivativeTable>
</ownershipDocument>
</XML>
</TEXT></DOCUMENT></SEC-DOCUMENT>"""


HEADER_8K = """<SEC-HEADER>
CONFORMED SUBMISSION TYPE:	8-K
ITEM INFORMATION:		Results of Operations and Financial Condition
ITEM INFORMATION:		Departure of Directors or Certain Officers; Election of Directors
ITEM INFORMATION:		Financial Statements and Exhibits
</SEC-HEADER>"""


def test_master_index_keeps_only_valid_rows_of_the_wanted_forms() -> None:
    rows = parse_master_index(INDEX, frozenset({"4", "8-K"}))
    assert [(r.cik, r.form) for r in rows] == [(320193, "4"), (1999999, "4"), (320193, "8-K")]
    assert rows[0].filed == date(2026, 10, 12)
    assert index_url(date(2026, 10, 12)).endswith("/daily-index/2026/QTR4/master.20261012.idx")


def test_form4_sums_open_market_buys_and_skips_other_codes() -> None:
    [t] = parse_form4(form4(), 320193)
    assert t.code == "P" and t.shares == 1500 and t.value == 1000 * 150.5 + 500 * 151
    assert t.owner == "Cook Timothy D" and t.role == "Chief Executive Officer, Director"
    assert t.day == date(2026, 10, 9) and t.planned is False
    [s] = parse_form4(form4(code="S", plan="1"), 320193)
    assert s.code == "S" and s.planned is True  # a pre-set 10b5-1 plan sale
    assert parse_form4(form4(code="A"), 320193) == []  # a grant, not a trade
    assert parse_form4(form4(), 789019) == []  # not this company's filing


def test_form4_rejects_bad_or_hostile_xml() -> None:
    assert parse_form4("no xml here", 320193) == []
    assert (
        parse_form4(form4(shares="lots"), 320193)[0].shares == 500
    )  # bad row skipped, not guessed
    bomb = """<XML><?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;">]>
<ownershipDocument><issuer><issuerCik>320193</issuerCik></issuer>&b;</ownershipDocument></XML>"""
    assert parse_form4(bomb, 320193) == []  # entity expansion is refused, never processed


def test_8k_items_are_read_from_the_header() -> None:
    assert parse_8k_items(HEADER_8K) == ["2.02", "5.02"]  # exhibits-only (9.01) left out
    assert parse_8k_items("nothing") == []


class FakeSec:
    def __init__(self, files: dict[str, str | None], fail_on: str | None = None) -> None:
        self.files = files
        self.calls: list[str] = []
        self.fail_on = fail_on

    def fetch_text(self, url: str, max_bytes: int = 0, stop_at: str | None = None) -> str | None:
        self.calls.append(url)
        if self.fail_on and self.fail_on in url:
            raise RateLimitedError("sec: HTTP 429 (rate limit or User-Agent)")
        for key, body in self.files.items():
            if url.endswith(key):
                return body
        return None


NOW = datetime(2026, 10, 13, 22, 0, tzinfo=UTC)


def _sec(**kw: Any) -> FakeSec:
    return FakeSec({
        "master.20261012.idx": INDEX,
        "0001140361-26-000001.txt": form4(),
        "0000320193-26-000077.txt": HEADER_8K,
    }, **kw)  # fmt: skip


def test_dossier_reads_new_days_and_keeps_history() -> None:
    sec = _sec()
    d = build_dossier(NOW, sec, {320193: ["AAPL"]}, None, budget_s=60)  # type: ignore[arg-type]
    assert not validate_dossier(d)
    aapl = d["companies"]["AAPL"]
    assert aapl["t"] == [
        [
            "2026-10-09",
            "Cook Timothy D",
            "Chief Executive Officer, Director",
            "P",
            1500,
            226000.0,
            0,
        ]
    ]
    assert aapl["e"] == [["2026-10-12", "2.02,5.02", "edgar/data/320193/0000320193-26-000077.txt"]]
    assert "2026-10-12" in d["days"] and "2026-10-13" not in d["days"]  # today waits for tonight
    # The insider's own filer row (CIK 1999999) and the 10-Q are ignored; each file is read once.
    assert sum("0001140361-26-000001" in u for u in sec.calls) == 1
    again = _sec()
    d2 = build_dossier(NOW, again, {320193: ["AAPL"]}, d, budget_s=60)  # type: ignore[arg-type]
    assert d2["companies"]["AAPL"] == aapl  # merged, not doubled
    assert not any("20261012" in u for u in again.calls)  # a day already read isn't read again


def test_rate_limit_stops_the_run_and_the_day_is_retried() -> None:
    sec = _sec(fail_on="20261012")
    d = build_dossier(NOW, sec, {320193: ["AAPL"]}, None, budget_s=60)  # type: ignore[arg-type]
    assert "2026-10-12" not in d["days"] and d["errors"] and "429" in d["errors"][0]
    assert d["companies"] == {}


def test_running_out_of_time_never_marks_a_day_done() -> None:
    d = build_dossier(NOW, _sec(), {320193: ["AAPL"]}, None, budget_s=0)  # type: ignore[arg-type]
    assert d["days"] == [] and d["companies"] == {}


def test_validation_catches_damage() -> None:
    assert validate_dossier({"schema": 2})
    assert validate_dossier({"schema": 1, "days": [], "companies": {"<x>": {"t": [], "e": []}}})
    bad = {
        "schema": 1,
        "days": [],
        "companies": {"AAPL": {"t": [["2026-10-09", "x", "y", "Z", 1, 1, 0]], "e": []}},
    }
    assert validate_dossier(bad)

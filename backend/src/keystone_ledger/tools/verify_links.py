"""Check every link in content/learn.json and stamp the ones that work.

Usage: `python -m keystone_ledger.tools.verify_links` (or `.\\tasks.ps1 verify-links`).
A link that loads (HTTP 2xx after at most 5 https-only redirects) gets `verified_on` = today;
one that fails gets `verified_on` = null, so the Learn page hides it until it works again.
"""

from __future__ import annotations

import json
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx

from keystone_ledger.learn import LEARN_PATH, LearnContent

MAX_REDIRECTS = 5
UA = "Mozilla/5.0 (KeystoneLedger link check; personal use)"


def check(client: httpx.Client, url: str) -> tuple[bool, str]:
    for _ in range(MAX_REDIRECTS + 1):
        if not url.startswith("https://"):
            return False, "redirected to a non-https address"
        try:
            # GET, not HEAD: several government sites answer HEAD with errors.
            with client.stream("GET", url) as resp:
                if resp.is_redirect:
                    url = str(resp.next_request.url) if resp.next_request else ""
                    continue
                return resp.is_success, f"HTTP {resp.status_code}"
        except httpx.HTTPError as exc:
            return False, type(exc).__name__
    return False, "too many redirects"


def verify(path: Path = LEARN_PATH, client: httpx.Client | None = None) -> tuple[int, int]:
    raw: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    LearnContent.model_validate(raw)  # refuse to touch an invalid file
    client = client or httpx.Client(
        timeout=20.0, follow_redirects=False, headers={"User-Agent": UA}
    )
    today = datetime.now(UTC).date().isoformat()
    ok = bad = 0
    for link in raw.get("links", []):
        good, why = check(client, link["url"])
        link["verified_on"] = today if good else None
        print(f"{'OK  ' if good else 'FAIL'} {why:<12} {link['url']}")
        ok, bad = ok + good, bad + (not good)
    path.write_text(json.dumps(raw, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return ok, bad


def main() -> int:
    ok, bad = verify()
    print(f"\n{ok} link(s) work, {bad} failed. Failed links stay hidden on the Learn page.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

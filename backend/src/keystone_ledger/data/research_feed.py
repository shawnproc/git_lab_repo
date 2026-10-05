"""The PC app's copy of the public research.json (Search), built by the daily GitHub job.

Reads are cache-only; only `refresh()` touches the network. A download is used only if it passes
`validate_research`; otherwise the last good copy stays and is marked stale with the error, so a
bad or missing file never shows as current.
"""

from __future__ import annotations

import json
import logging
import os
import threading
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import httpx

from keystone_ledger.core.auth import Clock, utcnow
from keystone_ledger.tools.research import validate_research

log = logging.getLogger(__name__)

MAX_BYTES = 30_000_000
MAX_AGE = timedelta(hours=12)


@dataclass(frozen=True)
class ResearchStatus:
    source: str
    fetched_at: datetime | None
    generated_at: str | None
    stale: bool
    reason: str
    last_error: str


class ResearchFeed:
    def __init__(
        self,
        url: str,
        cache_path: Path | None,
        clock: Clock = utcnow,
        client: httpx.Client | None = None,
    ) -> None:
        self.url = url
        self.cache_path = cache_path
        self.clock = clock
        self._client = client
        self._lock = threading.Lock()
        self._data: dict[str, Any] | None = None
        self._fetched_at: datetime | None = None
        self._error = ""
        self._load_cache()

    def _load_cache(self) -> None:
        if self.cache_path is None or not self.cache_path.is_file():
            return
        try:
            raw = json.loads(self.cache_path.read_text(encoding="utf-8"))
            data, fetched = raw["data"], datetime.fromisoformat(raw["fetched_at"])
        except (OSError, ValueError, KeyError, TypeError):
            log.warning("research: cached copy unreadable, ignoring it")
            return
        if fetched.tzinfo is None or validate_research(data):
            return
        self._data, self._fetched_at = data, fetched

    def data(self) -> dict[str, Any] | None:
        return self._data

    def status(self) -> ResearchStatus:
        reason = ""
        if self._data is None:
            reason = "search data hasn't been downloaded yet"
        elif self._fetched_at is not None and self.clock() - self._fetched_at > MAX_AGE:
            reason = "search data is more than 12 hours old"
        elif self._error:
            reason = "today's download failed, showing the last good copy"
        return ResearchStatus(
            source=self.url,
            fetched_at=self._fetched_at,
            generated_at=(self._data or {}).get("generated_at"),
            stale=bool(reason),
            reason=reason,
            last_error=self._error,
        )

    def needs_refresh(self) -> bool:
        return self._fetched_at is None or self.clock() - self._fetched_at > timedelta(hours=6)

    def _download(self) -> dict[str, Any]:
        client = self._client or httpx.Client(timeout=30.0, follow_redirects=False)
        try:
            with client.stream("GET", self.url, headers={"accept": "application/json"}) as r:
                if r.status_code != 200:
                    raise ValueError(f"HTTP {r.status_code}")
                body = bytearray()
                for chunk in r.iter_bytes():
                    body += chunk
                    if len(body) > MAX_BYTES:
                        raise ValueError("file is too big")
        finally:
            if self._client is None:
                client.close()
        data = json.loads(bytes(body))
        if not isinstance(data, dict):
            raise ValueError("not a research file")
        return data

    def refresh(self) -> ResearchStatus:
        with self._lock:
            try:
                data = self._download()
                errors = validate_research(data)
                if errors:
                    raise ValueError(errors[0])
            except (httpx.HTTPError, ValueError) as exc:
                self._error = f"research: {type(exc).__name__}: {str(exc)[:120]}"
                log.warning("research: refresh failed: %s", self._error)
                return self.status()
            self._data, self._fetched_at, self._error = data, self.clock(), ""
            self._save()
            return self.status()

    def _save(self) -> None:
        if self.cache_path is None or self._fetched_at is None:
            return
        tmp = self.cache_path.with_suffix(".tmp")
        try:
            self.cache_path.parent.mkdir(parents=True, exist_ok=True)
            payload = {"fetched_at": self._fetched_at.isoformat(), "data": self._data}
            tmp.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
            os.replace(tmp, self.cache_path)
        except OSError as exc:
            log.warning("research: couldn't save the cached copy: %s", type(exc).__name__)

    def company(self, symbol: str) -> dict[str, Any] | None:
        for c in (self._data or {}).get("companies", []):
            if isinstance(c, dict) and c.get("s") == symbol:
                return c
        return None

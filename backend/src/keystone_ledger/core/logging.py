"""Logging with secret redaction.

Defense in depth: code should never log secrets, but if a cookie, token, password or API key ever
reaches a log record (e.g. inside an exception message from a library), this filter masks it.
"""

from __future__ import annotations

import logging
import re

_PATTERNS = [
    re.compile(r"(?i)(kl_session=)[^;\s]+"),
    re.compile(r"(?i)(x-csrf-token['\"]?\s*[:=]\s*['\"]?)[^'\"\s,}]+"),
    re.compile(
        r"(?i)((?:api_?key|apikey|token|password|secret|setup_token)['\"]?\s*[:=]\s*['\"]?)"
        r"[^'\"\s&,}]+"
    ),
    re.compile(r"(?i)(authorization['\"]?\s*[:=]\s*['\"]?)[^'\"\n]+"),
]


def redact(text: str) -> str:
    for pat in _PATTERNS:
        text = pat.sub(r"\1[REDACTED]", text)
    return text


class RedactingFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        try:
            msg = record.getMessage()
        except (TypeError, ValueError):
            return True
        record.msg = redact(msg)
        record.args = None
        if record.exc_info and record.exc_info[1] is not None:
            record.exc_text = redact(logging.Formatter().formatException(record.exc_info))
            record.exc_info = None
        return True


def configure_logging(level: int = logging.INFO) -> None:
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    handler.addFilter(RedactingFilter())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level)
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        lg = logging.getLogger(name)
        lg.handlers[:] = []
        lg.propagate = True
    # Third-party HTTP clients can log full URLs (which may carry API keys) at DEBUG.
    for noisy in ("httpx", "httpcore", "urllib3", "yfinance", "peewee"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

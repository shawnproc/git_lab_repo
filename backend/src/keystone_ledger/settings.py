"""Process-level settings loaded from environment / `.env`.

These are deployment knobs (where the DB lives, which interface to bind). Trading rules live in
the TOML config (see `config.py`) so they are versioned, validated and audited separately.
"""

from __future__ import annotations

import ipaddress
import os
from functools import lru_cache
from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[3]


def default_data_dir() -> Path:
    """Where the DB and setup token live.

    On Windows, %LOCALAPPDATA% is per-user and ACL-protected by default (POSIX 0600 modes don't
    exist there). Elsewhere, `var/` in the repo, created 0700.
    """
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / "KeystoneLedger"
    return REPO_ROOT / "var"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="KL_",
        env_file=REPO_ROOT / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    data_dir: Path = Field(default_factory=default_data_dir)
    config_path: Path = Field(default=REPO_ROOT / "config" / "keystone.toml")

    host: str = "127.0.0.1"
    port: int = Field(default=8787, ge=1024, le=65535)
    # Binding to anything but loopback is refused unless explicitly allowed (Phase 4: Tailscale).
    allow_non_loopback: bool = False
    # Set when served behind HTTPS (e.g. `tailscale serve`); turns on the Secure cookie flag + HSTS.
    https: bool = False
    # Extra Host header values to accept (e.g. a Tailscale MagicDNS name). Loopback always is.
    extra_allowed_hosts: list[str] = Field(default_factory=list)
    # Extra Origins accepted on state-changing requests (the Vite dev server in `make dev`).
    dev_origins: list[str] = Field(default_factory=list)
    # Max accepted request body, bytes.
    max_body_bytes: int = Field(default=64 * 1024, ge=1024, le=10 * 1024 * 1024)

    session_idle_hours: float = Field(default=12.0, gt=0, le=24)
    session_absolute_days: float = Field(default=7.0, gt=0, le=30)
    login_max_failures: int = Field(default=5, ge=3, le=20)
    login_window_minutes: int = Field(default=15, ge=1)
    login_lockout_minutes: int = Field(default=15, ge=1)

    # SEC EDGAR fair-access policy requires a descriptive User-Agent with a contact address.
    sec_user_agent: str = ""

    @field_validator("host")
    @classmethod
    def _valid_host(cls, v: str) -> str:
        ipaddress.ip_address(v)  # raises on hostnames; we bind to explicit IPs only
        return v

    @property
    def db_path(self) -> Path:
        return self.data_dir / "keystone.sqlite3"

    @property
    def setup_token_path(self) -> Path:
        return self.data_dir / "setup-token.txt"

    @property
    def is_loopback(self) -> bool:
        return ipaddress.ip_address(self.host).is_loopback

    @property
    def allowed_hosts(self) -> list[str]:
        return ["127.0.0.1", "localhost", "::1", *self.extra_allowed_hosts]

    @property
    def allowed_origins(self) -> set[str]:
        scheme = "https" if self.https else "http"
        origins = {f"{scheme}://{h}:{self.port}" for h in ("127.0.0.1", "localhost", "[::1]")}
        origins |= {f"https://{h}" for h in self.extra_allowed_hosts}
        return origins | set(self.dev_origins)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()

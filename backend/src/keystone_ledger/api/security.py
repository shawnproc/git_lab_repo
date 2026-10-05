"""Transport-level defenses, as one pure-ASGI middleware (runs before routing).

1. Host header allowlist     -> blocks DNS-rebinding attacks against the loopback port.
2. Origin / Sec-Fetch-Site    -> rejects cross-site state-changing requests before any handler.
3. Body size cap              -> bounds memory per request.
4. Security headers           -> CSP, frame denial, nosniff, no-referrer, no-store for the API.

There is deliberately no CORS middleware: without it, browsers refuse cross-origin reads, which is
exactly the "same-origin only" policy we want.
"""

from __future__ import annotations

import json
from collections.abc import Iterable

from starlette.types import ASGIApp, Message, Receive, Scope, Send

UNSAFE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})

CSP = "; ".join(
    [
        "default-src 'self'",
        "script-src 'self'",
        # Chart libraries set inline style attributes; no inline <script> is ever allowed.
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self'",
        # finnhub.io: optional live prices, only with the owner's own key (frontend phone/live.ts)
        "connect-src 'self' https://finnhub.io",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
    ]
)

BASE_HEADERS: list[tuple[bytes, bytes]] = [
    (b"content-security-policy", CSP.encode()),
    (b"x-frame-options", b"DENY"),
    (b"x-content-type-options", b"nosniff"),
    (b"referrer-policy", b"no-referrer"),
    (b"cross-origin-opener-policy", b"same-origin"),
    (b"cross-origin-resource-policy", b"same-origin"),
    (b"permissions-policy", b"camera=(), microphone=(), geolocation=(), payment=(), usb=()"),
]


def _host_only(host_header: str) -> str:
    h = host_header.strip().lower()
    if h.startswith("["):  # [::1]:8787
        return h[1 : h.find("]")] if "]" in h else ""
    return h.rsplit(":", 1)[0] if ":" in h else h


class SecurityMiddleware:
    def __init__(
        self,
        app: ASGIApp,
        allowed_hosts: Iterable[str],
        allowed_origins: Iterable[str],
        max_body_bytes: int,
        hsts: bool,
    ) -> None:
        self.app = app
        self.allowed_hosts = {h.lower() for h in allowed_hosts}
        self.allowed_origins = {o.lower().rstrip("/") for o in allowed_origins}
        self.max_body = max_body_bytes
        self.headers = list(BASE_HEADERS)
        if hsts:
            self.headers.append((b"strict-transport-security", b"max-age=31536000"))

    async def _reject(self, send: Send, status: int, detail: str) -> None:
        body = json.dumps({"detail": detail}).encode()
        await send(
            {
                "type": "http.response.start",
                "status": status,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode()),
                    (b"cache-control", b"no-store"),
                    *self.headers,
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope["headers"]}
        if _host_only(headers.get("host", "")) not in self.allowed_hosts:
            await self._reject(send, 400, "invalid host header")
            return

        method = scope["method"].upper()
        if method in UNSAFE_METHODS:
            origin = headers.get("origin")
            site = headers.get("sec-fetch-site")
            if origin is not None and origin.lower().rstrip("/") not in self.allowed_origins:
                await self._reject(send, 403, "cross-origin request refused")
                return
            if site is not None and site not in ("same-origin", "none"):
                await self._reject(send, 403, "cross-site request refused")
                return

        try:
            declared = int(headers.get("content-length", "0"))
        except ValueError:
            await self._reject(send, 400, "invalid content-length")
            return
        if declared > self.max_body:
            await self._reject(send, 413, "request body too large")
            return

        received = 0

        async def limited_receive() -> Message:
            # Chunked bodies have no content-length; cut them off once they exceed the cap.
            nonlocal received
            msg = await receive()
            if msg["type"] == "http.request":
                received += len(msg.get("body", b""))
                if received > self.max_body:
                    return {"type": "http.disconnect"}
            return msg

        is_api = scope["path"].startswith("/api/")

        async def send_with_headers(msg: Message) -> None:
            if msg["type"] == "http.response.start":
                hdrs = [*msg.get("headers", []), *self.headers]
                if is_api:
                    hdrs.append((b"cache-control", b"no-store"))
                msg = {**msg, "headers": hdrs}
            await send(msg)

        await self.app(scope, limited_receive, send_with_headers)

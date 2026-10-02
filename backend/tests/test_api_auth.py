from __future__ import annotations

from fastapi.testclient import TestClient

from keystone_ledger.api.deps import AppState

from .conftest import BASE_URL, PASSWORD


def _cookie_header(resp) -> str:  # type: ignore[no-untyped-def]
    return "; ".join(v for k, v in resp.headers.multi_items() if k == "set-cookie")


def test_status_requires_setup(client: TestClient) -> None:
    r = client.get("/api/auth/status")
    assert r.json() == {
        "setup_required": True,
        "authenticated": False,
        "username": None,
        "csrf_token": None,
    }


def test_setup_requires_valid_token(client: TestClient, setup_token: str) -> None:
    r = client.post(
        "/api/auth/setup",
        json={"setup_token": "x" * 32, "username": "shawn", "password": PASSWORD},
    )
    assert r.status_code == 403


def test_setup_flow_and_cookie_flags(client: TestClient, setup_token: str, state: AppState) -> None:
    r = client.post(
        "/api/auth/setup",
        json={"setup_token": setup_token, "username": "shawn", "password": PASSWORD},
    )
    assert r.status_code == 201
    cookie = _cookie_header(r).lower()
    assert "kl_session=" in cookie
    assert "httponly" in cookie
    assert "samesite=strict" in cookie
    assert "secure" not in cookie  # plain http on loopback
    assert not state.settings.setup_token_path.exists()  # one-time token is consumed
    # Second setup refused.
    r2 = client.post(
        "/api/auth/setup",
        json={"setup_token": setup_token, "username": "eve", "password": PASSWORD},
    )
    assert r2.status_code == 409


def test_secure_cookie_when_https(client: TestClient, setup_token: str, state: AppState) -> None:
    object.__setattr__(state.settings, "https", True)
    r = client.post(
        "/api/auth/setup",
        json={"setup_token": setup_token, "username": "shawn", "password": PASSWORD},
    )
    assert "secure" in _cookie_header(r).lower()


def test_weak_password_rejected(client: TestClient, setup_token: str) -> None:
    r = client.post(
        "/api/auth/setup",
        json={"setup_token": setup_token, "username": "shawn", "password": "short"},
    )
    assert r.status_code == 422


def test_extra_fields_rejected(client: TestClient, setup_token: str) -> None:
    r = client.post(
        "/api/auth/setup",
        json={
            "setup_token": setup_token,
            "username": "shawn",
            "password": PASSWORD,
            "is_admin": True,
        },
    )
    assert r.status_code == 422


def test_login_logout(authed: TestClient) -> None:
    assert authed.get("/api/auth/status").json()["authenticated"] is True
    r = authed.post("/api/auth/logout")
    assert r.status_code == 204
    assert authed.get("/api/auth/status").json()["authenticated"] is False
    r = authed.post("/api/auth/login", json={"username": "shawn", "password": PASSWORD})
    assert r.status_code == 200
    assert r.json()["csrf_token"]


def test_login_lockout_returns_429(authed: TestClient) -> None:
    authed.cookies.clear()
    codes = [
        authed.post(
            "/api/auth/login", json={"username": "shawn", "password": "nope nope nope"}
        ).status_code
        for _ in range(6)
    ]
    assert codes[:4] == [401] * 4
    assert codes[4:] == [429, 429]
    r = authed.post("/api/auth/login", json={"username": "shawn", "password": PASSWORD})
    assert r.status_code == 429
    assert int(r.headers["retry-after"]) > 0


def test_csrf_required_for_state_changes(authed: TestClient) -> None:
    del authed.headers["x-csrf-token"]
    assert authed.post("/api/auth/logout").status_code == 403
    authed.headers["x-csrf-token"] = "forged"
    assert authed.post("/api/auth/logout").status_code == 403
    assert authed.post("/api/market/refresh").status_code == 403


def test_cross_origin_post_refused(authed: TestClient) -> None:
    r = authed.post("/api/auth/logout", headers={"origin": "https://evil.example"})
    assert r.status_code == 403
    r = authed.post("/api/auth/logout", headers={"sec-fetch-site": "cross-site"})
    assert r.status_code == 403


def test_dns_rebinding_host_refused(client: TestClient) -> None:
    r = client.get("/api/health", headers={"host": "attacker.example:8787"})
    assert r.status_code == 400
    assert client.get("/api/health", headers={"host": "localhost:8787"}).status_code == 200
    with TestClient(client.app, base_url="http://testserver") as other:
        assert other.get("/api/health").status_code == 400


def test_security_headers(client: TestClient) -> None:
    r = client.get("/api/health")
    h = r.headers
    assert "default-src 'self'" in h["content-security-policy"]
    assert "frame-ancestors 'none'" in h["content-security-policy"]
    assert h["x-frame-options"] == "DENY"
    assert h["x-content-type-options"] == "nosniff"
    assert h["referrer-policy"] == "no-referrer"
    assert h["cache-control"] == "no-store"
    assert "access-control-allow-origin" not in h
    assert "server" not in h


def test_no_cors_preflight(client: TestClient) -> None:
    r = client.options(
        "/api/auth/login",
        headers={"origin": "https://evil.example", "access-control-request-method": "POST"},
    )
    assert "access-control-allow-origin" not in r.headers


def test_body_size_limit(client: TestClient) -> None:
    r = client.post(
        "/api/auth/login",
        content=b"{" + b" " * (70 * 1024) + b"}",
        headers={"content-type": "application/json"},
    )
    assert r.status_code == 413


def test_protected_endpoints_require_auth(client: TestClient) -> None:
    for path in ("/api/market/status", "/api/market/bars/SPY", "/api/config"):
        assert client.get(path).status_code == 401, path


def test_no_docs_exposed(client: TestClient) -> None:
    for path in ("/docs", "/redoc", "/openapi.json"):
        assert client.get(path).status_code == 404


def test_base_url_is_loopback() -> None:
    assert BASE_URL.startswith("http://127.0.0.1")

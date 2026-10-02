from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest
from pydantic import ValidationError

from keystone_ledger.learn import LEARN_PATH, LearnContent, for_display, load_learn
from keystone_ledger.tools.verify_links import verify


def test_repo_learn_file_is_valid_and_https_only() -> None:
    c = load_learn(LEARN_PATH)
    assert all(str(link.url).startswith("https://") for link in c.links)
    assert len({g.term for g in c.glossary}) == len(c.glossary)  # no duplicate terms


def test_http_links_rejected() -> None:
    with pytest.raises(ValidationError):
        LearnContent.model_validate(
            {
                "links": [
                    {
                        "title": "x",
                        "url": "http://example.com",
                        "source": "s",
                        "kind": "article",
                        "topic": "t",
                    }
                ]
            }
        )


def _write(tmp_path: Path, urls: list[str]) -> Path:
    p = tmp_path / "learn.json"
    links = [
        {"title": u, "url": u, "source": "s", "kind": "article", "topic": "t",
         "verified_on": "2020-01-01"}
        for u in urls
    ]  # fmt: skip
    p.write_text(json.dumps({"glossary": [], "faq": [], "links": links}), encoding="utf-8")
    return p


def test_verify_links_stamps_good_and_hides_bad(tmp_path: Path) -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        path = req.url.path
        if path == "/ok":
            return httpx.Response(200)
        if path == "/moved":
            return httpx.Response(301, headers={"location": "https://a.example/ok"})
        if path == "/to-http":
            return httpx.Response(302, headers={"location": "http://a.example/ok"})
        return httpx.Response(404)

    urls = ["https://a.example/ok", "https://a.example/moved",
            "https://a.example/to-http", "https://a.example/gone"]  # fmt: skip
    p = _write(tmp_path, urls)
    client = httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=False)
    assert verify(p, client) == (2, 2)
    links = json.loads(p.read_text(encoding="utf-8"))["links"]
    assert [link["verified_on"] is not None for link in links] == [True, True, False, False]
    shown = for_display(load_learn(p))
    assert len(shown.links) == 2
    assert shown.pending_links == 2

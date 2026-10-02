"""Learn-page content from an editable JSON file, validated on every read."""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, field_validator

from keystone_ledger.settings import REPO_ROOT

LEARN_PATH = REPO_ROOT / "content" / "learn.json"
_MAX_BYTES = 1_000_000

Text = Annotated[str, Field(min_length=1, max_length=2000)]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class GlossaryEntry(_Strict):
    term: Annotated[str, Field(min_length=1, max_length=120)]
    definition: Text
    why_it_matters: Text


class FaqEntry(_Strict):
    q: Text
    a: Text


class LinkEntry(_Strict):
    title: Annotated[str, Field(min_length=1, max_length=200)]
    url: HttpUrl
    source: Annotated[str, Field(min_length=1, max_length=80)]
    kind: Literal["article", "video", "course", "tool"]
    topic: Annotated[str, Field(min_length=1, max_length=80)]
    verified_on: date | None = None

    @field_validator("url")
    @classmethod
    def _https(cls, v: HttpUrl) -> HttpUrl:
        if v.scheme != "https":
            raise ValueError("links must use https")
        return v


class LearnContent(_Strict):
    glossary: list[GlossaryEntry] = Field(default_factory=list, max_length=200)
    faq: list[FaqEntry] = Field(default_factory=list, max_length=100)
    links: list[LinkEntry] = Field(default_factory=list, max_length=200)


def load_learn(path: Path = LEARN_PATH) -> LearnContent:
    if not path.exists():
        return LearnContent()
    raw = path.read_bytes()
    if len(raw) > _MAX_BYTES:
        raise ValueError("learn.json is too large")
    return LearnContent.model_validate(json.loads(raw))

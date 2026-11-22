"""The guide (NOTES-26) over HTTP: making it again next to what is there. The rules are in ``services/guide.py``."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any, Literal

from fastapi import APIRouter, FastAPI
from pydantic import BaseModel

from ..db import SessionLocal
from ..deps import Account
from ..services import attachments, guide


def _start() -> None:
    guide.register()
    with SessionLocal() as db:
        guide.seed_existing(db)


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    await asyncio.to_thread(_start)
    yield


router = APIRouter(prefix="/api/guide", tags=["guide"], lifespan=lifespan)


class GuideIn(BaseModel):
    #: The language of the page; empty: the account's.
    language: Literal["de", "en", ""] = ""


@router.post("", status_code=201, summary="Make the guide again as a folder of its own, next to what is there")
def make(body: GuideIn, account: Account) -> dict[str, Any]:
    try:
        return guide.make(account.id, body.language or None, counted=True)
    except attachments.AttachmentError as exc:
        raise exc.http() from None

"""A note into nexlore (module verbinden, pair nexnotes → nexlore, purpose ``notes.add``; Runde 2 V19, Entwurf): once
connected with a click, "An nexlore" in a note's menu puts the note, its title and its Markdown, as a new note into a
space of nexlore the connection reaches. Everything goes over the connection (``nexverbinden.call``), never a key.

``GET /api/nexlore`` says whether nexlore is connected and which spaces it offers; ``POST /api/nexlore/send`` sends one
note. A locked note never goes (its text stays encrypted).
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlsplit

from fastapi import APIRouter
from pydantic import BaseModel, Field

from ..db import SessionLocal
from ..deps import Account, DbSession
from ..errors import error
from ..models import Note
from ..notedoc import doc as notedoc
from ..notedoc.markdown import to_markdown
from ..notedoc.room import Access as NoteAccess
from ..services import notes
from ..services.verbinden_store import CONFIG, VerbindenStore
from ..vendor import nexverbinden

router = APIRouter(prefix="/api/nexlore", tags=["nexlore"])

PARTNER = "nexlore"
#: The longest title nexlore takes.
MAX_TITLE = 1000


def _call(account_id: int, method: str, path: str, body: Any = None) -> Any:
    with SessionLocal() as db:
        try:
            answer = nexverbinden.call(VerbindenStore(db), CONFIG, account_id, PARTNER, method, path,
                                       datetime.now(UTC), body=body)
        except nexverbinden.Refused as refusal:
            if refusal.code == "not_connected":
                raise error("nexlore_not_connected", "Not connected with nexlore.", 409) from None
            if refusal.code == "unreachable":
                raise error("nexlore_unreachable", "The other app cannot be reached right now.", 502) from None
            raise error("nexlore_refused", "The other app does not take this connection any more.", 409) from None
    if answer.status >= 300:
        raise error("nexlore_refused", "The other app does not take this connection any more.", 409)
    return answer.data


def _spaces(account_id: int) -> list[dict[str, str]]:
    """The spaces nexlore lets the connection write into (``GET /api/v1/spaces``)."""
    found = _call(account_id, "GET", "/api/v1/spaces")
    rows = found if isinstance(found, list) else []
    return [{"id": str(row.get("name") or row.get("id")), "name": str(row.get("name") or row.get("id"))}
            for row in rows if isinstance(row, dict) and (row.get("name") or row.get("id"))][:200]


@router.get("", summary="Whether nexlore is connected (with a click) and the spaces a note may go into")
def status(account: Account, db: DbSession) -> dict[str, Any]:
    connection = VerbindenStore(db).connection(account.id, PARTNER)
    if connection is None:
        return {"connected": False, "spaces": []}
    return {"connected": True, "host": urlsplit(connection.partner_base).hostname or "",
            "spaces": _spaces(account.id)}


class NexloreSendIn(BaseModel):
    note_id: str = Field(min_length=1, max_length=36)
    space: str = Field(min_length=1, max_length=255)


@router.post("/send", summary="Put a note into a space of nexlore as a new note")
async def send(body: NexloreSendIn, account: Account) -> dict[str, Any]:
    with SessionLocal() as db:
        note = db.get(Note, body.note_id)
        if note is None or notes.access_to(db, account, note) not in (NoteAccess.READ, NoteAccess.WRITE):
            raise error("not_found", "Not found.", 404)
        if note.locked:
            raise error("note_locked", "The note is locked.", 409)

    def read(doc: Any) -> tuple[str, str]:
        return notedoc.title_of(doc), to_markdown(doc)

    title, markdown = await notes.change(body.note_id, read)
    made = _call(account.id, "POST", "/api/v1/notes",
                 {"folder": body.space, "title": (title or "Notiz")[:MAX_TITLE], "content": markdown})
    path = made.get("path") if isinstance(made, dict) else None
    return {"sent": True, "path": str(path or "")}

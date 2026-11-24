"""A member's own nextasks over HTTP (NOTES-19): connect, change the key, disconnect, the lists, send lines as tasks,
and the member's own marks beside the lines (``services/nextasks.py``). Every route that asks nextasks goes through
the account's brake (``nextasks.outgoing``)."""

from __future__ import annotations

from datetime import date
from typing import Annotated, Any

from fastapi import APIRouter, Path, Query, Request, Response
from pydantic import BaseModel, Field

from ..deps import Account, DbSession
from ..errors import error
from ..models_nextasks import NextasksLink
from ..services import nextasks, notes
from ..services.nextasks import NextasksError
from . import oauth

router = APIRouter(prefix="/api/nextasks", tags=["nextasks"])


class ConnectIn(BaseModel):
    url: str = Field(min_length=1, max_length=nextasks.MAX_URL)
    token: str = Field(min_length=1, max_length=nextasks.MAX_TOKEN)


class LineIn(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    anchor: str = Field(pattern=nextasks.ANCHOR.pattern)


class SendIn(BaseModel):
    note_id: str = Field(min_length=1, max_length=36)
    request_id: str = Field(pattern=nextasks.REQUEST.pattern)
    list_id: str = Field(pattern=nextasks.LIST_ID.pattern)
    list_name: str = Field(default="", max_length=300)
    due_date: date | None = None
    #: The lines, one task each; none with ``whole``: the whole note becomes one task.
    lines: list[LineIn] = Field(default_factory=list, max_length=nextasks.MAX_LINES)
    whole: bool = False


class AreasIn(BaseModel):
    #: Areas chosen whole (lists added later included), single lists of the other areas, the standard list.
    areas: list[Annotated[str, Field(max_length=100)]] = Field(default_factory=list, max_length=nextasks.MAX_AREAS)
    lists: list[Annotated[str, Field(max_length=130)]] = Field(default_factory=list, max_length=nextasks.MAX_CHOSEN)
    default: str | None = Field(default=None, max_length=130)


def _fail(exc: NextasksError, **more: Any) -> Exception:
    return exc.http(**more)


@router.get("", summary="The member's nextasks: connected, where, as whom, the list used last")
def status(account: Account, db: DbSession) -> dict[str, Any]:
    return nextasks.connection_out(db, nextasks.connection_of(db, account.id))


@router.put("", summary="Connect nextasks or change its key: address and key are checked at once")
def connect(body: ConnectIn, account: Account, db: DbSession) -> dict[str, Any]:
    try:
        with nextasks.outgoing(account.id, connecting=True):
            row = nextasks.connect(db, account.id, body.url, body.token)
    except NextasksError as exc:
        raise _fail(exc) from exc
    return nextasks.connection_out(db, row)


@router.delete("", status_code=204, summary="Disconnect nextasks; the tasks and the marks stay")
def disconnect(account: Account, db: DbSession) -> Response:
    nextasks.disconnect(db, account.id)
    return Response(status_code=204)


@router.get("/lists", summary="The lists chosen in Connections the key may write into; the standard list marked")
def lists(account: Account, db: DbSession) -> dict[str, Any]:
    """The browser's sending and the app's (with the device's token, interface 0.14): only the areas and lists chosen
    in Connections, each list with ``default`` (the standard list, chosen first), and the list used last."""
    try:
        return nextasks.offered(db, account.id)
    except NextasksError as exc:
        raise _fail(exc) from exc


@router.get("/areas", summary="Every area of nextasks with its lists: chosen whole, or which lists alone")
def areas(account: Account, db: DbSession) -> dict[str, Any]:
    try:
        return nextasks.areas_out(db, account.id)
    except NextasksError as exc:
        raise _fail(exc) from exc


@router.put("/areas", summary="Choose the areas and lists the sending offers, and the standard list")
def choose_areas(body: AreasIn, account: Account, db: DbSession) -> dict[str, Any]:
    try:
        return nextasks.choose(db, account.id, body.areas, body.lists, body.default)
    except NextasksError as exc:
        raise _fail(exc) from exc


def _clean_line(text: str) -> str:
    return " ".join(text.split())[: nextasks.MAX_TITLE]


@router.post("/send", summary="Each line becomes a task in nextasks with a link back to the note; a mark per line, "
             "or the whole note one task")
def send(body: SendIn, request: Request, account: Account, db: DbSession) -> dict[str, Any]:
    # Reading the note is enough (EC-5): the mark is the member's own, never written into the note.
    note = notes.note_for(db, account, body.note_id)
    if note.locked or notes.busy(db, note.id):
        # Never from a locked note (NOTES-16): its text is not the server's to hand on.
        raise error("note_locked", "The note is locked.", 409)
    note_url = f"{oauth.base_url(request, db)}/notes/{note.id}"
    if body.whole:
        # The whole note as one task: its title, its plain text in the task's notes (cut to nextasks' limit).
        title = _clean_line(note.title) or _clean_line(notes.suggest_title(note.text or ""))
        if body.lines or not title:
            raise error("invalid_input", "The input is not valid.", 422, fields=["lines"])
        try:
            with nextasks.outgoing(account.id):
                cut = nextasks.send_note(db, account.id, note_id=note.id, title=title, text=note.text or "",
                                         note_url=note_url, request_id=body.request_id, list_id=body.list_id,
                                         list_name=body.list_name, due=body.due_date)
        except NextasksError as exc:
            raise _fail(exc) from exc
        return {"sent": 1, "links": [], "cut": cut}
    lines = [nextasks.Line(text=_clean_line(line.text), anchor=line.anchor) for line in body.lines]
    if not lines or any(not line.text for line in lines):
        raise error("invalid_input", "The input is not valid.", 422, fields=["lines"])
    try:
        with nextasks.outgoing(account.id):
            made = nextasks.send(db, account.id, note_id=note.id, note_title=note.title, note_url=note_url,
                                 request_id=body.request_id, list_id=body.list_id, list_name=body.list_name,
                                 due=body.due_date, lines=lines)
    except NextasksError as exc:
        raise _fail(exc) from exc
    return {"sent": len(made), "links": [nextasks.link_out(row) for row in made]}


@router.get("/links", summary="The member's own marks of a note")
def links(account: Account, db: DbSession,
          note_id: Annotated[str, Query(min_length=1, max_length=36)]) -> dict[str, Any]:
    note = notes.note_for(db, account, note_id)
    return {"links": [nextasks.link_out(row) for row in nextasks.links_of(db, account.id, note.id)]}


def _own_link(db: DbSession, account_id: int, link_id: int) -> NextasksLink:
    row = db.get(NextasksLink, link_id)
    if row is None or row.account_id != account_id:
        raise error("not_found", "Not found.", 404)
    return row


@router.get("/links/{link_id}/open", summary="Where the task is now, or that nextasks has it no more")
def open_link(link_id: Annotated[int, Path(ge=1, le=2**62)], account: Account, db: DbSession) -> dict[str, Any]:
    row = _own_link(db, account.id, link_id)
    try:
        access = nextasks.connected_access(db, account.id)
        with nextasks.outgoing(account.id):
            state = nextasks.task_state(access, row.task_id)
    except NextasksError as exc:
        raise _fail(exc) from exc
    if state["gone"]:
        raise error("nextasks_task_gone", "This task is no longer in nextasks.", 404, trashed=state["trashed"])
    if state["link"] and state["link"] != row.task_url:
        row.task_url = state["link"]
        db.commit()
    # Without a public address nextasks gives no link to a task: then its start page.
    return {"url": state["link"] or row.task_url or access.url}


@router.delete("/links/{link_id}", status_code=204, summary="Remove a mark; the task in nextasks stays")
def remove_link(link_id: Annotated[int, Path(ge=1, le=2**62)], account: Account, db: DbSession) -> Response:
    row = _own_link(db, account.id, link_id)
    db.delete(row)
    db.commit()
    return Response(status_code=204)

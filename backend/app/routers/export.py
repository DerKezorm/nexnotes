"""Export over HTTP (NOTES-17): one note as Markdown or PDF at once, a folder or everything as a ZIP in the background
(``services/export.py``, ``services/export_pdf.py``)."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, FastAPI, Query, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask

from ..db import SessionLocal
from ..deps import Account, DbSession
from ..errors import error
from ..services import export


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    export.register()
    export.recover()
    yield


router = APIRouter(prefix="/api/export", tags=["export"], lifespan=lifespan)


def _disposition(name: str) -> str:
    """The download's name, umlauts included (RFC 6266), with a plain fallback for old clients."""
    plain = name.encode("ascii", "replace").decode("ascii").replace("?", "_").replace('"', "_")
    return f"attachment; filename=\"{plain}\"; filename*=UTF-8''{quote(name, safe='')}"


@router.get("/notes/{note_id}/markdown", summary="One note as Markdown; with attachments a ZIP of the file and them")
def note_markdown(note_id: str, account: Account) -> Response:
    name, body, kind = export.single_markdown(account, note_id)
    headers = {"Content-Disposition": _disposition(name), "Cache-Control": "no-store"}
    if isinstance(body, Path):
        return FileResponse(body, media_type=kind, headers=headers,
                            background=BackgroundTask(body.unlink, missing_ok=True))
    return Response(body, media_type=kind, headers=headers)


@router.get("/notes/{note_id}/pdf", summary="One note as PDF")
def note_pdf(note_id: str, account: Account) -> Response:
    name, body = export.note_pdf(account, note_id)
    return Response(body, media_type="application/pdf",
                    headers={"Content-Disposition": _disposition(name), "Cache-Control": "no-store"})


@router.get("/estimate", summary="About how big the ZIP of a folder (or, without one, of everything) gets")
def estimate(db: DbSession, account: Account,
             folder_id: str | None = Query(default=None, max_length=36)) -> dict[str, int]:
    try:
        return export.estimate(db, account, folder_id)
    except export.FolderGone as exc:
        raise error("not_found", "Not found.", 404) from exc


class JobIn(BaseModel):
    #: The folder with everything below it; left out: everything.
    folder_id: str | None = Field(default=None, max_length=36)


@router.post("/jobs", status_code=202, summary="Starts the export of a folder or of everything in the background")
def start(body: JobIn, db: DbSession, account: Account) -> dict[str, Any]:
    return export.job_out(export.start(db, account, body.folder_id))


@router.get("/jobs", summary="The account's exports of the last 24 hours")
def jobs(db: DbSession, account: Account) -> list[dict[str, Any]]:
    return [export.job_out(job) for job in export.jobs_of(db, account)]


@router.post("/jobs/{job_id}/seen", summary="The member saw the notice of this export")
def seen(job_id: str, db: DbSession, account: Account) -> dict[str, Any]:
    job = export.own_job(db, account, job_id)
    job.seen = True
    db.commit()
    return export.job_out(job)


@router.post("/jobs/{job_id}/restart", status_code=202, summary="Starts a failed export once more")
def restart(job_id: str, db: DbSession, account: Account) -> dict[str, Any]:
    return export.job_out(export.restart(db, account, job_id))


@router.get("/jobs/{job_id}/download", summary="The ZIP, for 24 hours, as often as asked")
def download(job_id: str, account: Account) -> FileResponse:
    with SessionLocal() as db:
        path, name = export.download_path(db, account, job_id)
    return FileResponse(path, media_type="application/zip",
                        headers={"Content-Disposition": _disposition(name), "Cache-Control": "no-store"})

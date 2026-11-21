"""Entry point: the FastAPI app, routers, background tasks, the built frontend."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exception_handlers import http_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import __version__, private
from .config import get_settings
from .db import SessionLocal, init_db
from .errors import detail
from .middleware import ForwardedProtoMiddleware, GuardMiddleware, RequestContextMiddleware, unhandled_error
from .routers import about, auth, export, folders, health, history, invites, oidc, trash
from .routers import accounts as accounts_router
from .routers import attachments as attachments_router
from .routers import avatars as avatars_router
from .routers import backups as backups_router
from .routers import locales as locales_router
from .routers import logs as logs_router
from .routers import mcp as mcp_router
from .routers import notes as notes_router
from .routers import notes_list as notes_list_router
from .routers import notify as notify_router
from .routers import oauth as oauth_router
from .routers import ocr as ocr_router
from .routers import search as search_router
from .routers import settings as settings_router
from .routers import shares as shares_router
from .routers import smart_folders as smart_folders_router
from .routers import tags as tags_router
from .routers import totp as totp_router
from .routers import vault as vault_router
from .security import HashingBusy, purge_sessions
from .services import accounts, backups, cleanup, locales, logs, mounts, oidc_store, settings_service, totp
from .vendor import nexoidc

logger = logging.getLogger("nexnotes")

#: The frame's routers. The note features add theirs here (``FEATURE_ROUTERS``), each a module with ``router``.
ROUTERS = [
    health, about, locales_router, logs_router, auth, totp_router, oidc, accounts_router, invites, settings_router,
    backups_router, avatars_router,
]
#: Routers of the note features (notes, folders, search, sharing ...), registered after the frame's.
#: The vault comes early: its start puts the locked notes into the hooks the others read at their own start.
FEATURE_ROUTERS: list = [folders, notes_router, vault_router, tags_router, search_router, history, trash,
                         notes_list_router, export, attachments_router, ocr_router, shares_router, notify_router,
                         mcp_router, oauth_router, smart_folders_router]


def _read_log_mode() -> tuple[str, datetime | None]:
    with SessionLocal() as db:
        mode = settings_service.get(db, "log_mode")
        raw = settings_service.get(db, "log_mode_until")
    until = datetime.fromisoformat(raw).astimezone(UTC) if raw else None
    return str(mode or logs.DEFAULT_MODE), until


def _write_log_mode(mode: str, until: datetime | None) -> None:
    with SessionLocal() as db:
        settings_service.save(db, {"log_mode": mode, "log_mode_until": until.isoformat() if until else None})


async def _sweep_forever(stop: asyncio.Event) -> None:
    """Enrolments and sign-ins waiting for their second factor run out; what ran out goes from memory, ended
    sessions from the database once an hour (they stayed until someone showed them again)."""
    rounds = 0
    while not stop.is_set():
        totp.sweep()
        if rounds % 60 == 0:
            with SessionLocal() as db:
                purge_sessions(db)
        rounds += 1
        try:
            await asyncio.wait_for(stop.wait(), 60)
        except TimeoutError:
            continue


def _backup_before_update() -> None:
    """A new version starting on data of an older one: a backup first, the way back if the new version goes wrong.
    Nothing to keep on a fresh data folder."""
    from sqlalchemy import inspect

    from .db import engine

    if not inspect(engine).has_table("settings"):
        return
    with SessionLocal() as db:
        known = str(settings_service.get(db, "running_version") or "")
    if known and known != __version__:
        logger.info("nexnotes %s starts on data of %s; a backup comes first", __version__, known)
        backups.create(kind=backups.UPDATE, note=f"before {__version__}")


def _remember_version() -> None:
    with SessionLocal() as db:
        if settings_service.get(db, "running_version") != __version__:
            settings_service.save(db, {"running_version": __version__})


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    logs.setup()
    settings = get_settings()
    # Said at every start while it lasts: a database on a share can lose notes.
    mounts.warn_at_start(settings.data_dir, settings.database_path)
    backups.apply_pending()
    _backup_before_update()
    init_db()
    _remember_version()
    # The TLS context of the calls to providers and authentik, read once here outside the event loop (vendor/nexoidc).
    await nexoidc.warm()
    private.tighten_all()
    logs.attach_store(_read_log_mode, _write_log_mode)
    logs.apply_stored_mode()
    for directory in (settings.locales_dir, backups.media_root()):
        if directory is not None:
            directory.mkdir(parents=True, exist_ok=True)
    added = locales.available()
    if added:
        logger.info("Languages added by the operator: %s", ", ".join(locale.code for locale in added))
    stop = asyncio.Event()
    tasks: list[asyncio.Task[None]] = []
    settings.resolved_secret_key()
    if not settings.disable_background:
        tasks.append(asyncio.create_task(logs.run_forever(stop)))
        tasks.append(asyncio.create_task(backups.run_forever(stop)))
        tasks.append(asyncio.create_task(cleanup.run_forever(stop)))
        tasks.append(asyncio.create_task(_sweep_forever(stop)))
    logger.info("nexnotes %s started", __version__)
    with SessionLocal() as db:
        accounts.announce_setup_code(db)
    try:
        yield
    finally:
        stop.set()
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        logger.info("nexnotes stopped")


app = FastAPI(
    title="nexnotes",
    version=__version__,
    lifespan=lifespan,
    docs_url="/api/docs" if get_settings().api_docs else None,
    openapi_url="/api/openapi.json" if get_settings().api_docs else None,
    redoc_url=None,
)
# Added last, runs first: the request id and headers wrap everything, the guard sits inside it.
app.add_middleware(GuardMiddleware)
app.add_middleware(RequestContextMiddleware)
# Outermost: the scheme a trusted proxy reports is known before anything looks at the request.
app.add_middleware(ForwardedProtoMiddleware)


@app.exception_handler(RequestValidationError)
async def _validation_error(_request: Request, exc: RequestValidationError) -> JSONResponse:
    fields = [".".join(str(part) for part in error.get("loc", ()) if part != "body") for error in exc.errors()]
    return JSONResponse(
        status_code=422, content={"detail": detail("invalid_input", "The input is not valid.", fields=fields)}
    )


@app.exception_handler(OverflowError)
async def _too_large_a_number(_request: Request, _exc: OverflowError) -> JSONResponse:
    # A number past what SQLite holds (an id like 99999999999999999999 in the address): not a fault of the server.
    return JSONResponse(status_code=422, content={"detail": detail("invalid_input", "The input is not valid.")})


@app.exception_handler(HashingBusy)
async def _hashing_busy(_request: Request, _exc: HashingBusy) -> JSONResponse:
    # Every slot for checking a password stayed taken for 15 s: many sign-ins at once, as in a flood of guesses.
    return JSONResponse(status_code=503, headers={"Retry-After": "5"},
                        content={"detail": detail("busy", "The server is busy. Try again in a moment.")})


@app.exception_handler(UnicodeEncodeError)
async def _not_unicode(_request: Request, _exc: UnicodeEncodeError) -> JSONResponse:
    # JSON may carry a lone surrogate ("\ud800"); no file name, path or database text can hold it.
    return JSONResponse(status_code=422, content={"detail": detail("invalid_input", "The input is not valid.")})


@app.exception_handler(StarletteHTTPException)
async def _plain_http_error(request: Request, exc: StarletteHTTPException) -> JSONResponse:
    # FastAPI's own 400 for a body that is not JSON carries only a text; give it a code like every other answer.
    if exc.status_code == 400 and isinstance(exc.detail, str):
        return JSONResponse(status_code=400, content={"detail": detail("invalid_input", "The input is not valid.")})
    # A file under /assets/ that is not there (an old page after an update), or a path no route knows: the same
    # answer as every other "not found", not Starlette's bare text.
    if exc.status_code == 404 and isinstance(exc.detail, str):
        return JSONResponse(status_code=404, content={"detail": detail("not_found", "Not found.")})
    return await http_exception_handler(request, exc)


app.add_exception_handler(Exception, unhandled_error)

for module in ROUTERS + FEATURE_ROUTERS:
    app.include_router(module.router)

# The shared sign-in module learns who it runs in before the first request (vendor/nexoidc).
oidc_store.configure()


def _mount_frontend(target: FastAPI, dist: Path) -> None:
    index = dist / "index.html"
    if not index.exists():
        return
    if (dist / "assets").is_dir():
        target.mount("/assets", StaticFiles(directory=dist / "assets"), name="assets")
    root = dist.resolve()
    start_page = index.resolve()

    @target.get("/{path:path}", include_in_schema=False, response_model=None)
    def spa(path: str) -> FileResponse | JSONResponse:
        if path == "api" or path.startswith("api/"):
            return JSONResponse(status_code=404, content={"detail": detail("not_found", "Not found.")})
        candidate = (dist / path).resolve()
        if path and candidate.is_file() and root in candidate.parents and candidate != start_page:
            return FileResponse(candidate)
        return FileResponse(index, headers={"Cache-Control": "no-cache"})


_mount_frontend(app, get_settings().frontend_dist)

"""Storage and backups over HTTP, operator only: the routes of the shared module ``sicherung``.

- ``/api/server/storage``: the module's own ways (the card "Speicher", the schedule with its time, the list, check,
  download, restore, delete, upload; the settings page uses these);
- ``/api/backups``: the ways nexnotes had before the module, in their old shapes and with the old password header
  ``x-nexnotes-password`` (the list as an array of flat entries, the check flat with ``usable``, a backup of a newer
  version refused with 400 ``backup_too_new``), so scripts and older pages keep working.

Download, restore, delete and upload ask for the operator's password again (``confirm_operator``: an account from a
provider confirms with a fresh sign-in there; wrong tries count like a sign-in).
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request

from ..db import SessionLocal
from ..deps import OperatorAccount, confirm_operator
from ..errors import error
from ..services import backups  # noqa: F401  (configures the module before its routes are used)
from ..vendor.nexsicherung import routes


def _confirm(request: Request, account: Any, password: str) -> None:
    with SessionLocal() as db:
        confirm_operator(request, db, account, password)


def _error(code: str, text: str, status: int) -> Exception:
    return error(code, text, status)


def _viewer(account: Any) -> int:
    """Whose own notes a check names by title (NOTES-2 AC-7)."""
    return int(account.id)


router = APIRouter()
router.include_router(routes.router(operator=OperatorAccount, confirm=_confirm, error=_error, viewer=_viewer,
                                    prefix="/api/server/storage"))
router.include_router(routes.legacy_router(prefix="/api/backups", password_header="x-nexnotes-password",
                                           operator=OperatorAccount, confirm=_confirm, error=_error, viewer=_viewer,
                                           check_raises_too_new=True))

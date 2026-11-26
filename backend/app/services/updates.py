"""Whether a newer nexnotes is out (block X2): the shared module ``updates`` (``vendor/nexupdates``) with nexnotes'
storage.

At most once a day the public GitHub API is asked for the newest release. Nothing goes out but the question itself: no
names, no notes, no settings, not even the server's version (the module's neutral ``nex-update-check``). The switch
``update_check`` stays where it was, with its value; an installation from before that never stored it keeps the check
on, a new one stores the answer of its setup (U1). Only the operator sees the state (U2, U15); a member sees its own
version. nexnotes has no bell for operators, so nothing looks in the background (U19): the operator's page asks.

The names of the module (``parse``, ``is_newer``, ``state``, ``forget``, ``State``, ``INTERVAL`` …) stand here.
"""

from __future__ import annotations

from .. import __version__ as RUNNING
from ..config import get_settings
from ..db import SessionLocal
from ..models import Setting
from ..vendor import nexupdates
from ..vendor.nexupdates import *  # the names of the old file (its __version__ is the module's)
from . import settings_service

REPO = "DerKezorm/nexnotes"
REPO_URL = f"https://github.com/{REPO}"
RELEASES_URL = f"{REPO_URL}/releases"
#: The project page: the repository while there is none (the about page leaves the row out then).
PROJECT_URL = REPO_URL
API_URL = f"https://api.github.com/repos/{REPO}/releases/latest"
KEY = "update_check"


def _read_switch() -> bool | None:
    """The switch as stored, None while nothing is: the default (on) is the module's, not ``settings_service``'s."""
    with SessionLocal() as db:
        row = db.get(Setting, KEY)
        return None if row is None else bool(row.value)


def _write_switch(on: bool) -> None:
    with SessionLocal() as db:
        settings_service.save(db, {KEY: bool(on)})


def configure() -> nexupdates.AppConfig:
    """The module on nexnotes' storage; at import and again at every start (a test may have changed it)."""
    return nexupdates.configure(nexupdates.AppConfig(
        app_name="nexnotes",
        version=lambda: RUNNING,
        repo=REPO,
        project_url=PROJECT_URL,
        update_url=lambda: get_settings().update_url,
        read_switch=_read_switch,
        write_switch=_write_switch,
        # No bell (U19): no background look; the operator's page asks once a day.
        on_newer=None,
        logger_name="nexnotes.updates",
    ))


CONFIG = configure()

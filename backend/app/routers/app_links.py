"""Links to notes open in the app for iPhone, iPad and Mac ("Universal Links", NOTES-24, NOTESIOS-29).

Apple asks every domain an app names for ``/.well-known/apple-app-site-association`` and opens the addresses it lists
in the app instead of the browser. Listed are the addresses of a note: ``/notes/<id>`` and a list with the note open
beside it (``?note=<id>``, as ``frontend/src/notes/workspace.ts`` makes them). Everything else stays in the browser:
read links ``/l/…`` (for people without an account), the start page, signing in, the settings, the API.

The file is served without signing in and before the setup: Apple's servers fetch it, never a person. Whether a link
really opens in the app decides the app: only for a server connected there (otherwise it hands the link back to the
browser), and only for domains the app was built with.
"""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from ..config import get_settings
from ..errors import detail

router = APIRouter()

#: The lists of the notes' workspace that carry an open note as ``?note=<id>``.
NOTE_LISTS = ("/", "/inbox", "/folders", "/folder/*", "/tags", "/tags/*", "/search", "/shared", "/shared/folder/*",
              "/smart/*")


def app_ids() -> list[str]:
    """``NEXNOTES_APPLE_APP_IDS`` as a list, empty entries left out."""
    return [entry.strip() for entry in get_settings().apple_app_ids.split(",") if entry.strip()]


def association(ids: list[str]) -> dict:
    """The file's content for the given apps. Apple takes the first component that fits, so what stays in the
    browser comes first."""
    components: list[dict] = [
        {"/": "/l/*", "exclude": True, "comment": "read links stay in the browser"},
        {"/": "/api/*", "exclude": True, "comment": "the interface is no page"},
        {"/": "/smart/new", "exclude": True, "comment": "a new smart folder, no note"},
        {"/": "/notes/*", "comment": "a note beside all notes"},
    ]
    components += [{"/": path, "?": {"note": "?*"}, "comment": "a list with a note open"} for path in NOTE_LISTS]
    return {"applinks": {"details": [{"appIDs": ids, "components": components}]}}


@router.get("/.well-known/apple-app-site-association", include_in_schema=False)
def apple_app_site_association() -> JSONResponse:
    ids = app_ids()
    if not ids:
        return JSONResponse(status_code=404, content={"detail": detail("not_found", "Not found.")})
    # Apple's CDN fetches it now and then; an hour is plenty for a change of the setting to arrive.
    return JSONResponse(association(ids), headers={"Cache-Control": "public, max-age=3600"})

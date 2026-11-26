"""Version and license (open to anybody), and whether a newer nexnotes is out (block X2): the routes of the shared
module ``updates`` (``vendor/nexupdates``) under ``/api/about``, as before.

Only the operator sees the state of the check and switches or asks (U2, U15): the question goes out for the whole
installation. A member gets ``GET /api/about/updates`` in the form of before with every field empty and ``hidden``
(U21), and its look never asks. The names in the API description are the ones of before (E53).
"""

from __future__ import annotations

from ..deps import require_account, require_operator
from ..models import OPERATOR
from ..services import updates
from ..vendor.nexupdates import api as nexupdates_api

REPO_URL = updates.REPO_URL

#: The summaries these routes had in /api/openapi.json before the module (E53).
SUMMARIES = {
    "about": "About nexnotes",
    "update_state": "Whether a newer nexnotes is out (asked once a day)",
}

router = nexupdates_api.router(
    account=require_account,
    operator=require_operator,
    is_operator=lambda account: getattr(account, "role", None) == OPERATOR,
    prefix="/api/about",
    tags=["about"],
    summaries=SUMMARIES,
)

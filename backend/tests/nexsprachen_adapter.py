"""nexsprachen contract tests: nexnotes' adapter (from the module's ``tools/sync.py copy``, then nexnotes' file).

nexnotes as in production: ``services/locales.py`` configures the module with ``NEXNOTES_LOCALES_DIR`` (in the tests
a fresh folder per test, set on the settings and put back afterwards), German and English built in, the routes under
``/api/locales`` readable without signing in, nexnotes' refusals (``{"detail": {"code", "message", …}}``), the
template made on the page (the server has none).
"""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path
from typing import Any

from sprachen_contract import StandardAdapter

OPERATOR_NAME = "sprachen-operator"


class Adapter(StandardAdapter):
    package = "app.vendor.nexsprachen"
    prefix = "/api/locales"
    also: tuple[str, ...] = ()
    built_in = {"de": "Deutsch", "en": "English"}  # noqa: RUF012 (the contract's base declares it so)
    public_read = True
    has_template = False
    # The description lives at /api/openapi.json (with NEXNOTES_API_DOCS); the operationIds and the
    # schema name of nexnotes' own router before the module stay.
    openapi_path = "/api/openapi.json"
    operation_ids: dict[str, str] = {  # noqa: RUF012 (the contract's base declares it so)
        "list": "list_locales_api_locales_get",
        "read": "read_locale_api_locales__code__get",
        "upload": "upload_locale_api_locales__code__put",
        "remove": "delete_locale_api_locales__code__delete",
    }
    summaries: dict[str, str] = {}  # noqa: RUF012
    schema_names: dict[str, str] = {"LanguageEntry": "LocaleEntry"}  # noqa: RUF012

    def start(self) -> None:
        from app.config import get_settings
        from app.services import locales

        self._clients: list[Any] = []
        self._settings = get_settings()
        self._before = self._settings.locales_dir
        # A fresh folder, as on a new server; nexnotes' own folder of the test session stays as it was.
        self._folder = Path(tempfile.mkdtemp(prefix="nexnotes-locales-"))
        self._settings.locales_dir = self._folder
        locales.forget()
        # /api/openapi.json is there only with NEXNOTES_API_DOCS (off in the tests, read once when the app is made):
        # for the contract the same description FastAPI serves there (``app.openapi()``), taken away again in stop.
        from app.main import app

        self._app = app
        app.add_api_route(self.openapi_path, lambda: app.openapi(), include_in_schema=False)
        self._docs_route = app.router.routes[-1]

    def stop(self) -> None:
        from app.services import locales

        for client in self._clients:
            client.close()
        self._settings.locales_dir = self._before
        self._app.router.routes.remove(self._docs_route)
        locales.forget()
        shutil.rmtree(self._folder, ignore_errors=True)

    def client(self, role: str) -> Any:
        from app.models import MEMBER, OPERATOR
        from tests.conftest import make_account, new_client

        if role == "anonymous":
            client = new_client()
        else:
            name = OPERATOR_NAME if role == "operator" else "sprachen-member"
            client = new_client(self._account(name, OPERATOR if role == "operator" else MEMBER, make_account))
        self._clients.append(client)
        return client

    @staticmethod
    def _account(name: str, role: str, make: Any) -> Any:
        from app.db import SessionLocal
        from app.models import Account

        with SessionLocal() as db:
            row = db.query(Account).filter_by(name=name).one_or_none()
            if row is not None:
                db.expunge(row)
                return row
        return make(name, role)

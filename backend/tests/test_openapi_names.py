"""E53: every route and schema nexnotes' API description named before the settings pass keeps its name. Each
operationId, summary and schema name of the branch konten (``tests/data/openapi_names_konten.json``) is still there
as it was; new routes and schemas may come. The description is nexnotes' own (``app.openapi()``, what
``/api/openapi.json`` serves with ``NEXNOTES_API_DOCS``)."""

from __future__ import annotations

import json
from pathlib import Path

from app.main import app

KONTEN = json.loads((Path(__file__).parent / "data" / "openapi_names_konten.json").read_text(encoding="utf-8"))


def _names() -> dict[str, dict[str, str | None]]:
    described = app.openapi()
    return {
        f"{method.upper()} {path}": {"operationId": operation.get("operationId"), "summary": operation.get("summary")}
        for path, operations in described["paths"].items()
        for method, operation in operations.items()
    }


def test_every_route_of_before_keeps_its_operation_id_and_summary() -> None:
    now = _names()
    changed = {route: (before, now.get(route)) for route, before in KONTEN["routes"].items() if now.get(route) != before}
    assert changed == {}
    assert len(KONTEN["routes"]) > 300


def test_every_schema_of_before_keeps_its_name() -> None:
    schemas = set(app.openapi().get("components", {}).get("schemas", {}))
    assert sorted(set(KONTEN["schemas"]) - schemas) == []


def test_the_names_this_pass_had_changed_are_back() -> None:
    now = _names()
    assert now["POST /api/auth/access/disconnect"]["summary"] == (
        "Disconnect all: every device, API token and passkey of the account")
    assert now["GET /api/locales"] == {"operationId": "list_locales_api_locales_get",
                                       "summary": "Languages the operator added"}

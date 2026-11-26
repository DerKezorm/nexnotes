"""The tab guard (``GuardMiddleware``, 400 ``client_required``) lets programs and the other nex apps through at the
routes they call without a browser tab: OAuth for AI programs (module mcp: register, token, revoke) and the token
routes between the nex apps (module verbinden: token, revoke, retire). A page without its tab at any other changing
route stays refused."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app

PROGRAM_POSTS = ("/api/oauth/register", "/api/oauth/token", "/api/oauth/revoke", "/api/connect/token",
                 "/api/connect/revoke", "/api/connect/retire")


@pytest.mark.parametrize("path", PROGRAM_POSTS)
def test_a_program_without_a_tab_header_gets_through(path: str) -> None:
    program = TestClient(app)
    answer = program.post(path, data={"grant_type": "x"})
    assert answer.status_code != 400 or "client_required" not in answer.text, answer.text


def test_a_page_without_its_tab_is_refused_elsewhere(client: TestClient, operator) -> None:
    bare = TestClient(app, cookies=dict(client.cookies))
    refused = bare.post("/api/notes", json={"title": "x"})
    assert refused.status_code == 400 and refused.json()["detail"]["code"] == "client_required"
    refused = bare.post("/api/connect/partners/nextasks/start", json={"address": "https://tasks.example.com"})
    assert refused.status_code == 400 and refused.json()["detail"]["code"] == "client_required"

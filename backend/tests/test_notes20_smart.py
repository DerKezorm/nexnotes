"""NOTES-20 AC-3, the part that waited for NOTES-7: a key that reads lists the member's smart folders."""

from __future__ import annotations

from .conftest import make_account, new_client
from .test_notes3 import new_note
from .test_notes20 import READ_TOOLS, fresh_brakes, key_for, ok, refused, tool_names  # noqa: F401


def test_notes20_ac3_a_read_key_lists_the_smart_folders_with_how_many_notes_fit(client, operator):
    token = key_for(operator, level="read")
    assert "list_smart_folders" in tool_names(client, token)
    assert tool_names(client, token) == READ_TOOLS
    new_note(client, markdown="- [ ] Milch\n- [x] Brot")
    new_note(client, markdown="- [x] fertig")
    made = client.post("/api/smart-folders", json={"name": "Kompost", "match": "all",
                                                   "conditions": [{"kind": "text", "value": "Kompost"}]})
    assert made.status_code == 201, made.text
    new_note(client, markdown="Kompost umsetzen")
    found = ok(client, token, "list_smart_folders")["smart_folders"]
    by_name = {folder["name"]: folder for folder in found}
    # The two every account gets carry no name of their own: their English name here, and their preset.
    assert by_name["Open checklists"]["preset"] == "open_tasks" and by_name["Open checklists"]["notes"] == 1
    assert by_name["Recently edited"]["notes"] == 3
    assert by_name["Kompost"]["notes"] == 1 and by_name["Kompost"]["conditions"][0]["kind"] == "text"
    # Symbol and colour as the sidebar shows them (fifth review).
    assert (by_name["Kompost"]["icon"], by_name["Kompost"]["color"]) == ("filter", "")
    assert by_name["Attachments"]["icon"] == "paperclip" and "Shared with me" not in by_name
    assert refused(client, token, "list_smart_folders", folder_id="x") == "There is no argument 'folder_id'."


def test_notes20_ac2_another_member_s_smart_folders_are_never_listed(client, operator):
    token = key_for(operator, level="read")
    anna = make_account("anna")
    with new_client(anna) as as_anna:
        assert as_anna.post("/api/smart-folders", json={"name": "Annas Ordner", "match": "all",
                                                        "conditions": [{"kind": "text", "value": "x"}]}
                            ).status_code == 201
    names = {folder["name"] for folder in ok(client, token, "list_smart_folders")["smart_folders"]}
    assert "Annas Ordner" not in names

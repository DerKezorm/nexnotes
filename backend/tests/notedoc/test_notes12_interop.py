"""Browser and server read and write the same document (NOTES-12 Technik: interop Yjs/Tiptap and pycrdt).

The fixtures were written in Node by ``interop/make-fixtures.mjs``: each one a note the browser made with Yjs,
y-prosemirror and the Tiptap schema of ``interop/schema.mjs``, with the ProseMirror JSON the browser reads back. The
first tests need no Node. The last ones hand what pycrdt wrote to Node (``interop/check-update.mjs``), which reads
it the way the browser does and checks it against the schema; they are skipped when Node or the packages are
missing.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest
from test_notes12_format import EVERYTHING

from app.notedoc import doc as notedoc
from app.notedoc import edit, yupdate
from app.notedoc import schema as s
from app.notedoc.markdown import from_markdown, to_markdown

FIXTURES = Path(__file__).resolve().parent / "fixtures"
INTEROP = Path(__file__).resolve().parents[3] / "interop"
CASES = sorted(path.stem for path in FIXTURES.glob("*.bin"))
#: A note from the random test as stored: the first state, then 22 updates as three browsers sent them (one of them
#: reconnecting, so an update waits for an earlier one for a moment) and the server's own changes.
CONCURRENT = sorted((FIXTURES / "concurrent").glob("*.bin"), key=lambda path: (path.name != "start.bin", path.name))


def _fixture(name: str) -> tuple[bytes, dict]:
    return (FIXTURES / f"{name}.bin").read_bytes(), json.loads((FIXTURES / f"{name}.json").read_text("utf-8"))


def test_notes12_interop_fixtures_cover_every_node_and_mark():
    assert len(CASES) >= 13
    seen_nodes, seen_marks = set(), set()

    def walk(node):
        seen_nodes.add(node["type"])
        for mark in node.get("marks", []):
            seen_marks.add(mark["type"])
        for child in node.get("content", []):
            walk(child)

    for name in CASES:
        walk(_fixture(name)[1]["doc"])
    assert set(s.NODE_ATTRS) | {"doc", "text"} <= seen_nodes
    assert set(s.MARKS) <= seen_marks


def test_notes12_interop_schema_of_the_browser_matches_the_server_tables():
    described = json.loads((FIXTURES / "schema.json").read_text("utf-8"))
    nodes = {name: spec["attrs"] for name, spec in described["nodes"].items() if name not in ("doc", "text")}
    assert nodes == s.NODE_ATTRS
    marks = {name: spec["attrs"] for name, spec in described["marks"].items()}
    assert marks == s.MARK_ATTRS
    # The order of the marks is the schema's rank; "code" excludes every other mark.
    assert list(s.MARKS) == [name for name, _ in sorted(described["marks"].items(), key=lambda kv: kv[1]["rank"])]
    assert described["marks"]["code"]["excludes"] == "_"
    assert described["nodes"]["taskItem"]["content"] == "paragraph block*"


@pytest.mark.parametrize("name", CASES)
def test_notes12_interop_server_reads_what_the_browser_wrote(name):
    update, expected = _fixture(name)
    doc = notedoc.load(update)
    assert notedoc.to_json(doc) == expected["doc"]
    assert notedoc.title_of(doc) == expected["title"]
    assert notedoc.format_of(doc) == 1
    # Cleaning a document the browser wrote changes nothing: the server's idea of the schema is the browser's.
    assert notedoc.clean_doc(expected["doc"]) == expected["doc"]
    # Writing it anew on the server gives the same document.
    assert notedoc.to_json(notedoc.new_doc(expected["title"], expected["doc"])) == expected["doc"]
    # And it survives Markdown, apart from what Markdown has no words for.
    assert to_markdown(from_markdown(to_markdown(doc))) == to_markdown(doc)


def _node() -> str | None:
    node = shutil.which("node")
    if node is None or not (INTEROP / "node_modules" / "y-prosemirror").exists():
        return None
    return node


def _browser_reads(tmp_path: Path, *updates: bytes) -> dict:
    node = _node()
    files = []
    for index, update in enumerate(updates):
        path = tmp_path / f"{index}.bin"
        path.write_bytes(update)
        files.append(str(path))
    result = subprocess.run([node, str(INTEROP / "check-update.mjs"), *files], capture_output=True, text=True,
                            timeout=120, cwd=INTEROP, encoding="utf-8", check=False)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


needs_node = pytest.mark.skipif(_node() is None, reason="Node or the interop packages are missing (cd interop && "
                                                         "npm install)")


@needs_node
def test_notes12_interop_browser_reads_every_node_the_server_wrote(tmp_path):
    doc = notedoc.new_doc("Alles 😀", EVERYTHING)
    seen = _browser_reads(tmp_path, doc.get_update())
    assert seen["doc"] == notedoc.to_json(doc)
    assert seen["title"] == "Alles 😀"
    assert seen["format"] == 1


@needs_node
@pytest.mark.parametrize("name", CASES)
def test_notes12_interop_server_changes_on_a_browser_document_read_back_in_the_browser(name, tmp_path):
    update, _ = _fixture(name)
    doc = notedoc.load(update)

    def change(d):
        notedoc.set_title(d, "Geändert ✓")
        edit.append_markdown(d, "## Vom Server\n\n- [ ] neu\n\n| a | b |\n| - | - |\n| 1 | **2** |\n\n> zitat")
        edit.append_task(d, "noch einer", checked=True)
        tasks = edit.list_tasks(d)
        if tasks:
            edit.toggle_task(d, 0)

    _, server_update = notedoc.change(doc, change)
    seen = _browser_reads(tmp_path, update, server_update)
    assert seen["doc"] == notedoc.to_json(doc)
    assert seen["title"] == "Geändert ✓"


@needs_node
def test_notes12_interop_concurrent_browser_and_server_changes_merge_for_the_browser(tmp_path):
    # The server appends while the browser (here: the fixture's author) had typed on; the browser reads the merge.
    update, _ = _fixture("taskList")
    server = notedoc.load(update)
    browser = notedoc.load(update)
    _, from_server = notedoc.change(server, lambda d: edit.append_paragraph(d, "vom Server"))
    _, from_browser = notedoc.change(browser, lambda d: edit.toggle_task(d, 2))
    seen = _browser_reads(tmp_path, update, from_browser, from_server)
    server.apply_update(from_browser)
    assert seen["doc"] == notedoc.to_json(server)


@needs_node
def test_notes12_interop_node_check_refuses_a_document_the_browser_cannot_read(tmp_path):
    from pycrdt import XmlElement, XmlFragment

    doc = notedoc.new_doc("x")
    body = doc.get("body", type=XmlFragment)
    body.children.append(XmlElement("taskList"))  # a checklist without items: the browser would drop it
    node = _node()
    path = tmp_path / "bad.bin"
    path.write_bytes(doc.get_update())
    result = subprocess.run([node, str(INTEROP / "check-update.mjs"), str(path)], capture_output=True, text=True,
                            timeout=120, cwd=INTEROP, check=False)
    assert result.returncode == 1
    # The room mends such a shape before anyone reads it.
    notedoc.repair(doc)
    assert _browser_reads(tmp_path, doc.get_update())["doc"] == notedoc.to_json(doc)


def test_notes12_state_after_concurrent_typing_encodes_cleanly():
    # pycrdt 0.14 (yrs 0.27 and later) writes this note, after the last update, as a state with overlapping blocks (a
    # skip of minus four) that Yjs in the browser keeps waiting; 0.14.0 even panics on it. This is why pycrdt stays
    # at 0.13 until that is fixed.
    doc = notedoc.load(CONCURRENT[0].read_bytes(), [path.read_bytes() for path in CONCURRENT[1:]])
    assert yupdate.well_formed(doc.get_update())


def test_notes12_well_formed_refuses_a_negative_skip():
    doc = notedoc.new_doc("x")
    assert yupdate.well_formed(doc.get_update())
    # One client, three structs: GC of 9, a skip of 2**32 - 4 (minus four for yrs), a GC of 4.
    broken = bytes([1, 3, 7, 0, 0, 9, 10]) + bytes.fromhex("fcffffff0f") + bytes([0, 4, 0])
    assert not yupdate.well_formed(broken)
    assert not yupdate.well_formed(b"")


@needs_node
def test_notes12_interop_browser_reads_the_state_after_concurrent_typing_without_waiting_parts(tmp_path):
    doc = notedoc.load(CONCURRENT[0].read_bytes(), [path.read_bytes() for path in CONCURRENT[1:]])
    seen = _browser_reads(tmp_path, doc.get_update())
    assert seen["doc"] == notedoc.to_json(doc)

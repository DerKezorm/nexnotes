"""NOTES-12 AC-2, AC-3, AC-4, AC-7, EC-1, EC-3: three browsers write at random at the same time, one of them goes
offline for long stretches and writes on, connections break again and again.

Every piece of typed text is a token (``[a17]``) typed in one go at a token boundary, so it can be found whole at the
end. What a browser deleted on purpose (a token, a paragraph, a checklist item, a table row) is noted with every token
it saw inside. At the end:

* every document (three browsers, the room, a fresh load from the store) is the same;
* every token nobody deleted knowingly is there exactly once: nothing lost (AC-2, AC-3, AC-4, EC-1), nothing doubled
  (EC-3); a deleted token is there at most once;
* every checklist item someone ticked and nobody deleted is ticked (AC-7).
"""

from __future__ import annotations

import asyncio
import random
import re

import pytest
from notedoc_sim import World
from pycrdt import XmlElement, XmlFragment, XmlText

from app.notedoc import doc as notedoc
from app.notedoc import edit, yupdate
from app.notedoc.markdown import to_plain

TOKEN = re.compile(r"\[[abc]\d+\]")


def _start_doc():
    def item(label):
        return {"type": "taskItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": label}]}]}

    def cell(kind, text):
        return {"type": kind, "content": [{"type": "paragraph", "content": [{"type": "text", "text": text}]}]}

    return notedoc.new_doc("Random", {"type": "doc", "content": [
        {"type": "paragraph", "content": [{"type": "text", "text": "Intro"}]},
        {"type": "taskList", "content": [item(f"{{t{i}}}") for i in range(8)]},
        {"type": "paragraph", "content": [{"type": "text", "text": "Middle"}]},
        {"type": "table", "content": [
            {"type": "tableRow", "content": [cell("tableHeader", "H1"), cell("tableHeader", "H2")]},
            {"type": "tableRow", "content": [cell("tableCell", "c1"), cell("tableCell", "c2")]},
            {"type": "tableRow", "content": [cell("tableCell", "c3"), cell("tableCell", "c4")]},
        ]},
        {"type": "paragraph", "content": [{"type": "text", "text": "End"}]},
    ]})


def _text_of(run: XmlText) -> str:
    return "".join(chunk for chunk, _ in run.diff() if isinstance(chunk, str))


def _tokens_in(element) -> list[str]:
    if isinstance(element, XmlText):
        return TOKEN.findall(_text_of(element))
    found = []
    for child in element.children:
        found.extend(_tokens_in(child))
    return found


class Browser:
    """What one simulated person does to its document."""

    def __init__(self, client, name: str, rng: random.Random, deleted: set[str], ticked: set[str]) -> None:
        self.client = client
        self.name = name
        self.rng = rng
        self.count = 0
        self.deleted = deleted
        self.ticked = ticked
        self.typed: list[str] = []

    @property
    def body(self) -> XmlFragment:
        return self.client.doc.get("body", type=XmlFragment)

    def _paragraphs(self, parent=None) -> list[XmlElement]:
        """Every paragraph one can type in: top level, in checklist items, in table cells."""
        parent = parent if parent is not None else self.body
        found = []
        for child in parent.children:
            if isinstance(child, XmlElement):
                if child.tag == "paragraph":
                    found.append(child)
                else:
                    found.extend(self._paragraphs(child))
        return found

    def _token(self) -> str:
        self.count += 1
        token = f"[{self.name}{self.count}]"
        self.typed.append(token)
        return token

    def type_somewhere(self) -> None:
        paragraphs = self._paragraphs()
        if not paragraphs:
            self.add_paragraph()
            return
        paragraph = self.rng.choice(paragraphs)
        runs = [child for child in paragraph.children if isinstance(child, XmlText)]
        run = self.rng.choice(runs) if runs else paragraph.children.append(XmlText())
        text = _text_of(run)
        # Token boundaries only: start, end, or right after a token or word.
        spots = [0, len(text)] + [m.end() for m in TOKEN.finditer(text)]
        spot = self.rng.choice(spots)
        run.insert(len(text[:spot].encode("utf-8")), self._token())

    def add_paragraph(self) -> None:
        index = self.rng.randint(0, len(self.body.children))
        paragraph = self.body.children.insert(index, XmlElement("paragraph"))
        paragraph.children.append(XmlText(self._token()))

    def delete_token(self) -> None:
        runs = [run for p in self._paragraphs() for run in p.children if isinstance(run, XmlText)]
        candidates = [(run, m) for run in runs for m in TOKEN.finditer(_text_of(run))]
        if not candidates:
            return
        run, match = self.rng.choice(candidates)
        text = _text_of(run)
        start = len(text[: match.start()].encode("utf-8"))
        del run[start: start + len(match.group(0))]
        self.deleted.add(match.group(0))

    def delete_paragraph(self) -> None:
        top = [i for i, child in enumerate(self.body.children)
               if isinstance(child, XmlElement) and child.tag == "paragraph"]
        if len(top) < 2:
            return
        index = self.rng.choice(top)
        self.deleted.update(_tokens_in(self.body.children[index]))
        del self.body.children[index]

    def _task_items(self) -> list[tuple[XmlElement, XmlElement]]:
        found = []
        for child in self.body.children:
            if isinstance(child, XmlElement) and child.tag == "taskList":
                found.extend((child, item) for item in child.children if isinstance(item, XmlElement))
        return found

    def tick(self) -> None:
        items = self._task_items()
        if not items:
            return
        _, item = self.rng.choice(items)
        label = re.search(r"\{t\d+\}", "".join(_tokens_in_text(item)))
        item.attributes["checked"] = True
        if label:
            self.ticked.add(label.group(0))

    def delete_task_item(self) -> None:
        items = self._task_items()
        if len(items) < 3:
            return
        task_list, item = self.rng.choice(items)
        self.deleted.update(_tokens_in(item))
        label = re.search(r"\{t\d+\}", "".join(_tokens_in_text(item)))
        if label:
            self.deleted.add(label.group(0))
        for index, child in enumerate(task_list.children):
            if child == item:
                del task_list.children[index]
                break

    def _table(self) -> XmlElement | None:
        for child in self.body.children:
            if isinstance(child, XmlElement) and child.tag == "table":
                return child
        return None

    def add_row(self) -> None:
        table = self._table()
        if table is None:
            return
        row = table.children.insert(len(table.children), XmlElement("tableRow"))
        for _ in range(2):
            cell = row.children.append(XmlElement("tableCell", {"colspan": 1, "rowspan": 1}))
            paragraph = cell.children.append(XmlElement("paragraph"))
            paragraph.children.append(XmlText(self._token()))

    def delete_row(self) -> None:
        table = self._table()
        if table is None or len(table.children) < 3:
            return
        index = self.rng.randint(1, len(table.children) - 1)
        self.deleted.update(_tokens_in(table.children[index]))
        del table.children[index]

    def act(self) -> None:
        roll = self.rng.random()
        if roll < 0.55:
            self.type_somewhere()
        elif roll < 0.62:
            self.add_paragraph()
        elif roll < 0.70:
            self.delete_token()
        elif roll < 0.76:
            self.delete_paragraph()
        elif roll < 0.86:
            self.tick()
        elif roll < 0.89:
            self.delete_task_item()
        elif roll < 0.95:
            self.add_row()
        else:
            self.delete_row()


def _tokens_in_text(element) -> list[str]:
    if isinstance(element, XmlText):
        return [_text_of(element)]
    out = []
    for child in element.children:
        out.extend(_tokens_in_text(child))
    return out


async def _run(seed: int, steps: int) -> dict[str, int]:
    rng = random.Random(seed)
    world = World()
    world.store.state = _start_doc().get_update()
    deleted: set[str] = set()
    ticked: set[str] = set()
    clients = [world.client(name, number, client_id=seed * 10 + number) for number, name in enumerate("abc", 1)]
    browsers = [Browser(client, client.name, rng, deleted, ticked) for client in clients]
    for client in clients:
        client.connect()
    await world.settle()
    offline_until = -1
    stats = {"breaks": 0, "offline": 0, "rescued": 0}
    for step in range(steps):
        browser = rng.choice(browsers)
        browser.act()
        # C goes offline for long stretches and writes on (AC-4); A's line wobbles (EC-3).
        c = clients[2]
        if c.connected and rng.random() < 0.03:
            c.disconnect()
            offline_until = step + rng.randint(20, 80)
            stats["offline"] += 1
        elif not c.connected and step >= offline_until and rng.random() < 0.5:
            c.connect()
        a = clients[0]
        if a.connected and rng.random() < 0.04:
            a.disconnect()
            stats["breaks"] += 1
        elif not a.connected and rng.random() < 0.5:
            a.connect()
        # Messages travel only now and then, so many changes cross each other.
        roll = rng.random()
        if roll < 0.15:
            await world.settle()
        elif roll < 0.5:
            await world.step(rng.randint(1, 30))
    for client in clients:
        if not client.connected:
            client.connect()
    await world.settle()
    room = world.rooms.room_of("note")
    assert room is not None
    stored = notedoc.load(world.store.state, [update for update, _ in world.store.updates])
    docs = {"a": clients[0].doc, "b": clients[1].doc, "c": clients[2].doc, "room": room.doc, "store": stored}
    expected = notedoc.to_json(room.doc)
    for name, doc in docs.items():
        assert notedoc.to_json(doc) == expected, f"seed {seed}: {name} differs"
        assert notedoc.title_of(doc) == "Random"
    plain = to_plain(room.doc)
    for browser in browsers:
        for token in browser.typed:
            count = plain.count(token)
            if token in deleted:
                assert count <= 1, f"seed {seed}: deleted {token} is there {count} times"
            else:
                assert count == 1, f"seed {seed}: {token} is there {count} times"
    items = {}
    for task in edit.list_tasks(room.doc):
        label = re.search(r"\{t\d+\}", task.text)
        if label:
            items[label.group(0)] = task.checked
    for label in ticked - deleted:
        if label in items:
            assert items[label], f"seed {seed}: {label} was ticked and is not"
    # The document stays one the browser's schema takes, and its state reads in Yjs as it does in pycrdt.
    assert notedoc.clean_doc(expected) == expected
    assert yupdate.well_formed(room.doc.get_update()), f"seed {seed}: the state does not encode cleanly"
    stats["tokens"] = sum(len(b.typed) for b in browsers)
    stats["rescued"] = sum(1 for _ in TOKEN.finditer(plain))
    await world.rooms.shutdown()
    return stats


def test_notes12_ac2_ac3_ac4_ac7_ec1_ec3_random_edits_from_three_browsers_fixed_seed():
    stats = asyncio.run(_run(seed=20261121, steps=600))
    assert stats["offline"] >= 1 and stats["breaks"] >= 3 and stats["tokens"] > 200


@pytest.mark.parametrize("seed", [1, 2, 3, 5, 8, 13, 21, 34])
def test_notes12_ac2_ac3_ac4_ac7_ec1_ec3_random_edits_more_seeds(seed):
    asyncio.run(_run(seed=seed, steps=300))

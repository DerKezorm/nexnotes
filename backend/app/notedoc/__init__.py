"""The note document, format "nexnotes-doc 1" (pycrdt; the browser uses Yjs with Tiptap).

* ``schema``: names, attributes, limits.
* ``doc``: make, load, read as ProseMirror JSON, write from it, title, safe links.
* ``markdown``: Markdown and plain text out, Markdown snippets in.
* ``edit``: changes the server makes (title, paragraph, Markdown, checklist items).
* ``room``: the live room (y-websocket protocol, rights, storing, folding), free of FastAPI and the database.
* ``rescue``, ``yupdate``: text typed into a paragraph someone else deleted at the same time stays.
"""

from .doc import (
    FormatError,
    attachment_refs,
    change,
    clean_doc,
    clean_title,
    from_json,
    load,
    new_doc,
    safe_href,
    set_title,
    title_of,
    to_json,
)
from .edit import Task, TaskNotFound, append_markdown, append_paragraph, append_task, list_tasks, toggle_task
from .markdown import from_markdown, to_markdown, to_plain
from .schema import FORMAT, MAX_DOC, MAX_TITLE, MAX_UPDATE

__all__ = [
    "FORMAT",
    "MAX_DOC",
    "MAX_TITLE",
    "MAX_UPDATE",
    "FormatError",
    "Task",
    "TaskNotFound",
    "append_markdown",
    "append_paragraph",
    "append_task",
    "attachment_refs",
    "change",
    "clean_doc",
    "clean_title",
    "from_json",
    "from_markdown",
    "list_tasks",
    "load",
    "new_doc",
    "safe_href",
    "set_title",
    "title_of",
    "to_json",
    "to_markdown",
    "to_plain",
    "toggle_task",
]

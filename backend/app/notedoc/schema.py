"""The note format "nexnotes-doc 1": names, attributes and limits.

One ``Y.Doc`` per note, the same for the browser (Tiptap over ``y-prosemirror``), the server (``pycrdt``) and the iOS
app (``yrs``):

* ``body`` (``XmlFragment``): the text. Every ProseMirror node is an ``XmlElement`` named like the Tiptap node, its
  attributes are the element's attributes (``None`` is left out, as ``y-prosemirror`` does). Runs of text are
  ``XmlText``; a mark is a formatting attribute on the run, named like the mark, its value the mark's attributes
  (``{"bold": {}}``, ``{"link": {"href": ...}}``).
* ``title`` (``Text``): the title, at most ``MAX_TITLE`` characters, edited live like the text.
* ``meta`` (``Map``): ``format`` = ``FORMAT``.

Attachments (NOTES-10) are blocks without content that name the attachment by its ``id``; the file itself is never in
the document: ``image`` (a picture, with its ``size`` small, medium or full width), ``attachment`` (a PDF, a video, any
other file) and ``linkPreview`` (the card of a link: its target, title, description, site and the ``id`` of the stored
picture of the page). They extend format 1: nothing that was there changes.

The browser's schema is ``interop/schema.mjs``; ``backend/tests/notedoc/fixtures/schema.json`` is written from it and
a test compares it with the tables here. Changing the format needs a new ``FORMAT`` number.
"""

from __future__ import annotations

from typing import Any

#: The version of the format. A document with a higher one is not changed by this server.
FORMAT = 1

#: Names of the shared types in the document.
BODY = "body"
TITLE = "title"
META = "meta"

# Node names (Tiptap).
DOC = "doc"
PARAGRAPH = "paragraph"
HEADING = "heading"
BULLET_LIST = "bulletList"
ORDERED_LIST = "orderedList"
LIST_ITEM = "listItem"
TASK_LIST = "taskList"
TASK_ITEM = "taskItem"
TABLE = "table"
TABLE_ROW = "tableRow"
TABLE_HEADER = "tableHeader"
TABLE_CELL = "tableCell"
BLOCKQUOTE = "blockquote"
CODE_BLOCK = "codeBlock"
HORIZONTAL_RULE = "horizontalRule"
HARD_BREAK = "hardBreak"
TEXT = "text"
# Attachments (NOTES-10): blocks without content.
IMAGE = "image"
ATTACHMENT = "attachment"
LINK_PREVIEW = "linkPreview"

# Mark names (Tiptap).
BOLD = "bold"
ITALIC = "italic"
UNDERLINE = "underline"
STRIKE = "strike"
CODE = "code"
LINK = "link"
HIGHLIGHT = "highlight"

#: Every attribute of every node with its default, as the browser's schema has them. ``y-prosemirror`` writes every
#: attribute that is not ``None``, defaults included; the server does the same so both write identical elements.
NODE_ATTRS: dict[str, dict[str, Any]] = {
    PARAGRAPH: {},
    HEADING: {"level": 1, "collapsed": False},
    BULLET_LIST: {},
    ORDERED_LIST: {"start": 1, "type": None},
    LIST_ITEM: {},
    TASK_LIST: {"doneToBottom": False},
    TASK_ITEM: {"checked": False},
    TABLE: {},
    TABLE_ROW: {},
    TABLE_HEADER: {"colspan": 1, "rowspan": 1, "colwidth": None, "align": None},
    TABLE_CELL: {"colspan": 1, "rowspan": 1, "colwidth": None, "align": None},
    BLOCKQUOTE: {},
    CODE_BLOCK: {"language": None},
    HORIZONTAL_RULE: {},
    HARD_BREAK: {},
    IMAGE: {"id": None, "size": "medium", "name": None},
    ATTACHMENT: {"id": None, "name": None},
    LINK_PREVIEW: {"href": None, "title": None, "description": None, "site": None, "image": None},
}

#: Every mark with the defaults of its attributes. The order is the schema's rank (the browser sorts marks by it).
MARK_ATTRS: dict[str, dict[str, Any]] = {
    LINK: {"href": None, "target": "_blank", "rel": "noopener noreferrer nofollow", "class": None, "title": None},
    BOLD: {},
    CODE: {},
    ITALIC: {},
    STRIKE: {},
    UNDERLINE: {},
    HIGHLIGHT: {"color": None},
}
MARKS = tuple(MARK_ATTRS)

#: Nodes that hold blocks, and which children they take.
BLOCKS = frozenset({PARAGRAPH, HEADING, BULLET_LIST, ORDERED_LIST, TASK_LIST, TABLE, BLOCKQUOTE, CODE_BLOCK,
                    HORIZONTAL_RULE, IMAGE, ATTACHMENT, LINK_PREVIEW})
#: Blocks that name an attachment and hold nothing (NOTES-10).
ATOMS = frozenset({IMAGE, ATTACHMENT, LINK_PREVIEW})
#: Nodes that hold inline content (text runs and hard breaks).
TEXTBLOCKS = frozenset({PARAGRAPH, HEADING})
LISTS = {BULLET_LIST: LIST_ITEM, ORDERED_LIST: LIST_ITEM, TASK_LIST: TASK_ITEM}
CELLS = frozenset({TABLE_HEADER, TABLE_CELL})

#: Heading levels a note knows (Tiptap is configured with these).
HEADING_LEVELS = (1, 2, 3)
#: The fixed row of highlight colours; ``None`` is the default colour (honey). The browser maps names to theme colours.
HIGHLIGHT_COLORS = ("honey", "green", "blue", "rose", "violet")
#: Schemes a link may point to (NOTES-3 EC-8); any other link loses its mark and stays plain text.
LINK_SCHEMES = ("http", "https", "mailto")

#: Sizes of a picture in the note (NOTES-10 AC-2); the first is the default.
IMAGE_SIZES = ("medium", "small", "full")
#: The id of an attachment: what the browser makes (22 characters of base64url), never a path.
ATTACHMENT_ID = r"^[A-Za-z0-9_-]{16,32}$"

# Limits.
#: The title, in characters (NOTES-3 EC-7).
MAX_TITLE = 120
#: One update from a browser, in bytes. A paste of a long text fits easily; attachments are not in the document.
MAX_UPDATE = 2 * 1024 * 1024
#: The whole document, in bytes (state as one update). Two hours of dictation are far below.
MAX_DOC = 16 * 1024 * 1024
#: An awareness message (cursor, name, colour), in bytes.
MAX_AWARENESS = 64 * 1024
#: Awareness client ids one connection may speak for.
MAX_AWARENESS_CLIENTS = 8
#: A Markdown snippet the server appends (MCP, nexdeck), in characters.
MAX_MARKDOWN = 512 * 1024
#: One checklist item the server appends, in characters.
MAX_TASK_TEXT = 10_000
#: A link target, in characters.
MAX_HREF = 2048
#: The name of an attachment, the title, description and site of a link card, in characters.
MAX_NAME = 200
MAX_CARD_TITLE = 300
MAX_CARD_TEXT = 500
#: Nesting of blocks (lists in lists, quotes in quotes) the server reads or writes; deeper content is flattened.
MAX_DEPTH = 32
#: Updates kept before they are folded into the stored document.
FOLD_AFTER = 200

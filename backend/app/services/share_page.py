"""The page of a read link (NOTES-13 AC-12, EC-5, EC-11; NOTES-22 AC-6): a note for somebody without an account.

Drawn on the server as plain HTML, light, without a single script: the note's document (ProseMirror JSON, the same the
export reads) becomes elements, every text and every attribute escaped. Links keep only the schemes a note allows
(``schema.LINK_SCHEMES``) and open without telling the target where they came from. Pictures and files of the note go
through the link itself (``/l/<token>/a/<id>``), and only those the note names today (``allowed``); nothing else of the
server is named on the page: no id of a note, a folder or an account, only the owner's shown name (AC-12).

The page speaks the language of the visitor's browser (``Accept-Language``): German, English, or a language the
operator added (``services/locales.py``) that holds the keys ``readLink.page.*``; anything else gets English.

A messenger that fetches the page for a preview (EC-11) gets a page with the title and "nexnotes" and nothing of the
text (``is_preview_bot``).
"""

from __future__ import annotations

import html
import re
import secrets
from collections.abc import Callable
from datetime import date
from typing import Any

from ..notedoc import schema as s
from . import locales

#: The texts of the page. Keys as in an operator's locale file under ``readLink.page``.
TEXTS: dict[str, dict[str, str]] = {
    "en": {
        "sharedBy": "Shared by {name}",
        "readOnly": "read only",
        "validUntil": "valid until {date}",
        "pdf": "Download as PDF",
        "footer": "Made with nexnotes · self-hosted",
        "goneTitle": "This link no longer works",
        "goneText": "It has expired or was withdrawn. Ask the person who sent it to you for a new one.",
        "slowTitle": "Too many attempts",
        "slowText": "Please wait a moment before you try again.",
        "untitled": "Untitled",
        "file": "File",
        "picture": "Picture",
        "recording": "Recording",
    },
    "de": {
        "sharedBy": "Geteilt von {name}",
        "readOnly": "nur lesen",
        "validUntil": "gültig bis {date}",
        "pdf": "Als PDF laden",
        "footer": "Erstellt mit nexnotes · selbst gehostet",
        "goneTitle": "Dieser Link gilt nicht mehr",
        "goneText": "Er ist abgelaufen oder wurde zurückgenommen. Frag die Person, die ihn dir geschickt hat, nach "
                    "einem neuen.",
        "slowTitle": "Zu viele Versuche",
        "slowText": "Bitte warte einen Moment, bevor du es noch einmal versuchst.",
        "untitled": "Ohne Titel",
        "file": "Datei",
        "picture": "Bild",
        "recording": "Aufnahme",
    },
}

_MONTHS_EN = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

#: User agents of programs that fetch a page for a preview: messengers, social networks, search engines (EC-11).
_PREVIEW_BOTS = re.compile(
    r"bot\b|bot/|crawler|spider|facebookexternalhit|facebot|whatsapp|telegram|slack|discord|skypeuripreview|"
    r"iframely|embedly|mastodon|signal|viber|threema|line/|kakaotalk|snapchat|pinterest|redditbot|linkedin|"
    r"bingpreview|google-inspectiontool|preview",
    re.IGNORECASE,
)


def is_preview_bot(user_agent: str | None) -> bool:
    return bool(user_agent) and bool(_PREVIEW_BOTS.search(user_agent or ""))


# --- Language -------------------------------------------------------------------------------------------------------


def _operator_texts(code: str) -> dict[str, str] | None:
    try:
        found = locales.load(code)
    except Exception:  # noqa: BLE001 - a broken or missing file is no language for the page
        return None
    page = ((found or {}).get("readLink") or {}).get("page") if isinstance(found, dict) else None
    if not isinstance(page, dict):
        return None
    texts = {key: value for key, value in page.items() if key in TEXTS["en"] and isinstance(value, str)}
    return texts or None


def language(accept_language: str | None) -> tuple[str, dict[str, str]]:
    """The visitor's language and the page's texts in it, English for what is missing (NOTES-22 EC-1)."""
    wanted: list[tuple[float, int, str]] = []
    for position, part in enumerate((accept_language or "").split(",")[:20]):
        pieces = part.strip().split(";")
        code = pieces[0].strip()
        weight = 1.0
        for piece in pieces[1:]:
            name, _, value = piece.strip().partition("=")
            if name == "q":
                try:
                    weight = float(value)
                except ValueError:
                    weight = 0.0
        if code and code != "*" and weight > 0:
            wanted.append((-weight, position, code))
    for _weight, _position, code in sorted(wanted):
        base = code.split("-")[0].lower()
        if base in TEXTS:
            return base, TEXTS[base]
        for candidate in (code, base):
            if locales.valid_code(candidate):
                found = _operator_texts(candidate)
                if found is not None:
                    return candidate, {**TEXTS["en"], **found}
    return "en", TEXTS["en"]


def day_text(day: str, lang: str) -> str:
    """The last day of a link as people of the language write it (NOTES-22 AC-4)."""
    try:
        value = date.fromisoformat(day)
    except ValueError:
        return day
    if lang == "de":
        return f"{value.day:02d}.{value.month:02d}.{value.year}"
    if lang == "en":
        return f"{_MONTHS_EN[value.month - 1]} {value.day}, {value.year}"
    return value.isoformat()


# --- The note as HTML -----------------------------------------------------------------------------------------------


def _e(text: Any) -> str:
    return html.escape(str(text if text is not None else ""), quote=True)


def safe_href(href: Any) -> str | None:
    """A link target a note may have (http, https, mailto), else nothing."""
    if not isinstance(href, str):
        return None
    target = href.strip()
    scheme = target.split(":", 1)[0].lower() if ":" in target else ""
    if scheme not in s.LINK_SCHEMES or re.search(r"[\x00-\x20\x7f]", target):
        return None
    return target


class Writer:
    """Turns the document into HTML. ``file_url(id, kind)`` is the address of an attachment through the link, or
    None for one the page may not show."""

    def __init__(self, texts: dict[str, str], file_url: Callable[[str, str], str | None]) -> None:
        self.texts = texts
        self.file_url = file_url

    def inline(self, nodes: list[dict[str, Any]]) -> str:
        out: list[str] = []
        for node in nodes or []:
            kind = node.get("type")
            if kind == s.HARD_BREAK:
                out.append("<br>")
                continue
            if kind != s.TEXT:
                continue
            text = _e(node.get("text", ""))
            for mark in node.get("marks") or []:
                text = self.mark(mark, text)
            out.append(text)
        return "".join(out)

    def mark(self, mark: dict[str, Any], inner: str) -> str:
        kind = mark.get("type")
        attrs = mark.get("attrs") or {}
        if kind == s.BOLD:
            return f"<strong>{inner}</strong>"
        if kind == s.ITALIC:
            return f"<em>{inner}</em>"
        if kind == s.UNDERLINE:
            return f"<u>{inner}</u>"
        if kind == s.STRIKE:
            return f"<s>{inner}</s>"
        if kind == s.CODE:
            return f"<code>{inner}</code>"
        if kind == s.HIGHLIGHT:
            color = attrs.get("color") if attrs.get("color") in s.HIGHLIGHT_COLORS else "honey"
            return f'<mark class="hl-{color}">{inner}</mark>'
        if kind == s.LINK:
            href = safe_href(attrs.get("href"))
            if href is None:
                return inner
            return f'<a href="{_e(href)}" rel="noopener noreferrer nofollow" target="_blank">{inner}</a>'
        return inner

    def blocks(self, nodes: list[dict[str, Any]]) -> str:
        return "".join(self.block(node) for node in nodes or [])

    def block(self, node: dict[str, Any]) -> str:
        kind = node.get("type")
        attrs = node.get("attrs") or {}
        children = node.get("content") or []
        if kind == s.PARAGRAPH:
            return f"<p>{self.inline(children) or '<br>'}</p>"
        if kind == s.HEADING:
            level = attrs.get("level") if attrs.get("level") in s.HEADING_LEVELS else 1
            return f"<h{level + 1}>{self.inline(children)}</h{level + 1}>"
        if kind == s.BULLET_LIST:
            return f"<ul>{self.blocks(children)}</ul>"
        if kind == s.ORDERED_LIST:
            start = attrs.get("start")
            start_attr = f' start="{int(start)}"' if isinstance(start, int) and start != 1 else ""
            return f"<ol{start_attr}>{self.blocks(children)}</ol>"
        if kind == s.LIST_ITEM:
            return f"<li>{self.blocks(children)}</li>"
        if kind == s.TASK_LIST:
            return f'<ul class="tasks">{self.blocks(children)}</ul>'
        if kind == s.TASK_ITEM:
            checked = bool(attrs.get("checked"))
            box = '<span class="box done" aria-hidden="true">&#10003;</span>' if checked \
                else '<span class="box" aria-hidden="true"></span>'
            return f'<li class="{"done" if checked else "open"}">{box}<div>{self.blocks(children)}</div></li>'
        if kind == s.BLOCKQUOTE:
            return f"<blockquote>{self.blocks(children)}</blockquote>"
        if kind == s.CODE_BLOCK:
            text = "".join(_e(child.get("text", "")) for child in children if child.get("type") == s.TEXT)
            return f"<pre><code>{text}</code></pre>"
        if kind == s.HORIZONTAL_RULE:
            return "<hr>"
        if kind == s.TABLE:
            return f'<div class="table"><table>{self.blocks(children)}</table></div>'
        if kind == s.TABLE_ROW:
            return f"<tr>{self.blocks(children)}</tr>"
        if kind in s.CELLS:
            tag = "th" if kind == s.TABLE_HEADER else "td"
            span = ""
            for name in ("colspan", "rowspan"):
                value = attrs.get(name)
                if isinstance(value, int) and 1 < value <= 1000:
                    span += f' {name}="{value}"'
            return f"<{tag}{span}>{self.blocks(children)}</{tag}>"
        if kind in (s.IMAGE, s.DRAWING):
            return self.picture(attrs)
        if kind in (s.ATTACHMENT, s.RECORDING):
            return self.file(attrs, "recording" if kind == s.RECORDING else "file")
        if kind == s.LINK_PREVIEW:
            return self.card(attrs)
        return ""

    def picture(self, attrs: dict[str, Any]) -> str:
        url = self.file_url(str(attrs.get("id") or ""), "view")
        if url is None:
            return ""
        size = attrs.get("size") if attrs.get("size") in s.IMAGE_SIZES else "medium"
        alt = attrs.get("name") or self.texts["picture"]
        return f'<figure class="pic {size}"><img src="{_e(url)}" alt="{_e(alt)}" loading="lazy"></figure>'

    def file(self, attrs: dict[str, Any], word: str) -> str:
        url = self.file_url(str(attrs.get("id") or ""), "file")
        if url is None:
            return ""
        name = attrs.get("name") or self.texts[word]
        return f'<p class="file"><a href="{_e(url)}" rel="noopener noreferrer">{_e(name)}</a></p>'

    def card(self, attrs: dict[str, Any]) -> str:
        href = safe_href(attrs.get("href"))
        title = attrs.get("title") or href or ""
        if not title:
            return ""
        picture = ""
        if attrs.get("image"):
            url = self.file_url(str(attrs.get("image")), "view")
            if url is not None:
                picture = f'<img src="{_e(url)}" alt="" loading="lazy">'
        parts = [f"<strong>{_e(title)}</strong>"]
        if attrs.get("description"):
            parts.append(f"<span>{_e(attrs.get('description'))}</span>")
        if attrs.get("site"):
            parts.append(f'<span class="site">{_e(attrs.get("site"))}</span>')
        inner = f'{picture}<span class="text">{"".join(parts)}</span>'
        if href is None:
            return f'<div class="card">{inner}</div>'
        return f'<a class="card" href="{_e(href)}" rel="noopener noreferrer nofollow" target="_blank">{inner}</a>'


# --- Pages ----------------------------------------------------------------------------------------------------------

#: The logo: the note on its white tile (as drawn for the app).
_LOGO = ('<svg width="28" height="28" viewBox="0 0 64 64" aria-hidden="true"><rect x="2" y="2" width="60" height="60" '
         'rx="16" fill="#ffffff" stroke="#e0a51c" stroke-opacity=".35" stroke-width="1.5"/>'
         '<path d="M21 14h17l9 9v26a4 4 0 '
         '0 1-4 4H21a4 4 0 0 1-4-4V18a4 4 0 0 1 4-4Z" fill="none" stroke="#d09514" stroke-width="5" '
         'stroke-linejoin="round"/><path d="M23.5 33h16M23.5 42h10" fill="none" stroke="#c48a0e" stroke-width="5" '
         'stroke-linecap="round"/></svg>')

_STYLE = """
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;background:#f5f5f8;color:#14141a;font-family:Inter,'Segoe UI',system-ui,-apple-system,sans-serif;
 min-height:100vh;display:flex;flex-direction:column;align-items:center}
header{width:100%;padding:14px 20px;background:#fff;border-bottom:1px solid #dcdce4;display:flex;flex-wrap:wrap;
 align-items:center;gap:12px}
header .who{font-size:14px;color:#61616f;overflow-wrap:anywhere}
header .who strong{color:#14141a}
header .pdf{margin-left:auto;text-decoration:none;height:36px;padding:0 12px;border-radius:9px;border:1px solid #8a8a97;
 color:#14141a;font-size:13px;display:flex;align-items:center}
article{width:100%;max-width:720px;padding:40px 24px;display:flex;flex-direction:column;gap:14px;font-size:16px;
 line-height:1.7;overflow-wrap:anywhere}
article h1{margin:0;font-size:32px;line-height:1.2;font-weight:700;letter-spacing:-0.02em}
article h2{margin:8px 0 0;font-size:22px}article h3{margin:8px 0 0;font-size:19px}
article h4{margin:6px 0 0;font-size:17px}
article p{margin:0}article ul,article ol{margin:0;padding-left:22px}
article ul.tasks{list-style:none;padding-left:0}
article ul.tasks li{display:flex;gap:10px;align-items:flex-start}
article ul.tasks li.done>div{color:#61616f;text-decoration:line-through}
.box{flex:none;width:18px;height:18px;margin-top:4px;border-radius:5px;border:1.5px solid #8a8a97;display:inline-flex;
 align-items:center;justify-content:center;font-size:12px;line-height:1}
.box.done{background:#f2c14e;border-color:#f2c14e;color:#2a1d00}
blockquote{margin:0;padding-left:14px;border-left:3px solid #dcdce4;color:#3d3d48}
pre{margin:0;padding:12px 14px;border-radius:10px;background:#ececf1;overflow-x:auto;font-size:14px;line-height:1.5}
code{font-family:ui-monospace,'SF Mono',Consolas,monospace;font-size:.92em}
hr{border:0;border-top:1px solid #dcdce4;width:100%}
.table{overflow-x:auto}table{border-collapse:collapse;font-size:15px}
th,td{border:1px solid #dcdce4;padding:6px 10px;vertical-align:top;text-align:left}th{background:#ececf1}
td p,th p{margin:0}
mark{border-radius:3px;padding:0 3px;color:inherit}
.hl-honey{background:rgba(242,193,78,.45)}.hl-green{background:rgba(74,222,128,.35)}
.hl-blue{background:rgba(96,165,250,.35)}.hl-rose{background:rgba(251,113,133,.35)}.hl-violet{background:rgba(167,139,250,.35)}
a{color:#8a6400}a:hover{color:#5c4300}
figure{margin:0}figure img{max-width:100%;height:auto;border-radius:10px;display:block}
figure.small img{max-width:min(100%,280px)}figure.medium img{max-width:min(100%,480px)}
.file a{display:inline-flex;padding:8px 12px;border:1px solid #dcdce4;border-radius:9px;background:#fff;
 text-decoration:none;color:#14141a}
.card{display:flex;gap:12px;padding:10px;border:1px solid #dcdce4;border-radius:12px;background:#fff;
 text-decoration:none;color:#14141a}
.card img{width:96px;height:72px;object-fit:cover;border-radius:8px;flex:none}
.card .text{display:flex;flex-direction:column;gap:2px;font-size:14px;line-height:1.4;min-width:0}
.card .site{color:#61616f;font-size:12.5px}
footer{margin-top:auto;padding:20px;font-size:12.5px;color:#61616f}
main.gone{flex:1;width:100%;padding:48px 16px;display:flex;align-items:center;justify-content:center}
main.gone div{width:100%;max-width:440px;padding:32px 28px;border-radius:16px;background:#fff;border:1px solid #dcdce4;
 display:flex;flex-direction:column;align-items:center;gap:14px;text-align:center}
main.gone h1{margin:0;font-size:22px}main.gone p{margin:0;font-size:15px;line-height:1.55;color:#61616f}
@media print{header,footer{display:none}body{background:#fff}article{padding:0}}
"""


def policy(nonce: str) -> str:
    """The page's own policy: no script at all, pictures from here, its one style block (EC-4 of NOTES-10)."""
    return (f"default-src 'none'; img-src 'self'; style-src 'nonce-{nonce}'; base-uri 'none'; form-action 'none'; "
            "frame-ancestors 'none'")


def _page(lang: str, title: str, body: str, nonce: str, *, meta: str = "") -> str:
    return (f'<!doctype html><html lang="{_e(lang)}"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width, initial-scale=1">'
            '<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer">'
            f"<title>{_e(title)}</title>{meta}"
            f'<style nonce="{nonce}">{_STYLE}</style></head><body>{body}</body></html>')


def _preview_meta(title: str) -> str:
    """What a messenger takes for its preview: "nexnotes" and the title, nothing of the text (EC-11)."""
    return (f'<meta name="description" content="nexnotes"><meta property="og:site_name" content="nexnotes">'
            f'<meta property="og:title" content="{_e(title)}"><meta property="og:description" content="nexnotes">'
            '<meta property="og:type" content="article"><meta name="twitter:card" content="summary">')


def new_nonce() -> str:
    return secrets.token_urlsafe(16)


def _fill(text: str, name: str, value: str) -> str:
    """A value into a text, written ``{name}`` or as in the frontend's files ``{{name}}``."""
    return text.replace("{{" + name + "}}", value).replace("{" + name + "}", value)


def note_page(*, lang: str, texts: dict[str, str], title: str, document: dict[str, Any], owner: str,
              expires_on: str, pdf_url: str, file_url: Callable[[str, str], str | None], nonce: str) -> str:
    """The note as the link shows it (AC-12): who shared it, read only, until when, "Als PDF laden", the note,
    "Erstellt mit nexnotes"."""
    shown = title or texts["untitled"]
    who = _fill(_e(texts["sharedBy"]), "name", f"<strong>{_e(owner)}</strong>")
    until = _fill(_e(texts["validUntil"]), "date", _e(day_text(expires_on, lang)))
    body = (f'<header>{_LOGO}<span class="who">{who} · {_e(texts["readOnly"])} · {until}</span>'
            f'<a class="pdf" href="{_e(pdf_url)}" rel="nofollow">{_e(texts["pdf"])}</a></header>'
            f'<article><h1>{_e(shown)}</h1>{Writer(texts, file_url).blocks(document.get("content") or [])}</article>'
            f'<footer>{_e(texts["footer"])}</footer>')
    return _page(lang, f"{shown} · nexnotes", body, nonce, meta=_preview_meta(shown))


def preview_page(*, lang: str, title: str, nonce: str) -> str:
    """For a program that fetches the page for a preview (EC-11): the title and "nexnotes", no text."""
    return _page(lang, f"{title} · nexnotes", f"<main><h1>{_e(title)}</h1><p>nexnotes</p></main>", nonce,
                 meta=_preview_meta(title))


def gone_page(*, lang: str, texts: dict[str, str], nonce: str, slow: bool = False) -> str:
    """"Dieser Link gilt nicht mehr", without a title (EC-5); the same for every link that does not work, so a
    visitor cannot tell an unknown link from one that ended. ``slow``: too many tries (EC-7)."""
    heading = texts["slowTitle"] if slow else texts["goneTitle"]
    text = texts["slowText"] if slow else texts["goneText"]
    body = (f'<main class="gone"><div>{_LOGO.replace("28", "56", 2)}<h1>{_e(heading)}</h1><p>{_e(text)}</p></div>'
            "</main>")
    return _page(lang, f"{heading} · nexnotes", body, nonce,
                 meta='<meta name="description" content="nexnotes"><meta property="og:title" content="nexnotes">')

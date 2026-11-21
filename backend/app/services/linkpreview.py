"""The card of a link pasted into a note (NOTES-10 AC-5): title, description, site and picture of the page.

The server asks the page on behalf of the person pasting, so whoever runs the page learns that someone at this server
pasted its address; the operator can switch it off (``link_previews``, AC-9). Then nothing is fetched at all.

A server that asks addresses it is handed must never be turned against its own network (EC-5):

* only ``http`` and ``https``, no user name or password in the address, only the ports 80 and 443, never the server's
  own address (``own_hosts``);
* the name is resolved once and every address it gives must be public: no loopback, private, link-local, shared,
  reserved or multicast address, no metadata service, also not hidden in an IPv6 address (``outbound.pin``); the
  connection goes to exactly the address checked;
* redirects are followed by hand, at most ``MAX_REDIRECTS``, each one checked again;
* only HTML for the page (at most ``MAX_PAGE`` read), only pictures for the picture (at most ``MAX_PICTURE``), each in
  ``SECONDS`` all told; the picture is drawn anew like any attached one, so nothing of the file but its pixels comes in.

A page that cannot be reached, a server without internet (EC-11) or an address that is refused gives no card: the
link stays a plain link. The log names the host, never the whole address (it may hold a key).
"""

from __future__ import annotations

import html
import io
import logging
import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from html.parser import HTMLParser
from typing import Any
from urllib.parse import urljoin, urlsplit

import httpx

from ..notedoc import schema as s
from ..notedoc.doc import clean_label, safe_href
from . import avatars, outbound

logger = logging.getLogger("nexnotes.links")

SECONDS = 5.0
CONNECT_SECONDS = 2.0
MAX_PAGE = 512 * 1024
MAX_PICTURE = 5 * 1024 * 1024
MAX_REDIRECTS = 3
PORTS = (80, 443)
#: The edge of the stored picture of a page, in pixels.
PICTURE_EDGE = 800
AGENT = "nexnotes (link preview)"
#: Picture formats of a page taken for its card.
PICTURE_KINDS = {"jpeg", "png", "webp", "gif"}

#: Stand-ins for the tests: how a name is resolved, and the transport of the requests (``None``: the network).
RESOLVER: Callable[[str, int], list[str]] = outbound.resolve
TRANSPORT: httpx.BaseTransport | None = None


@dataclass
class Card:
    href: str
    title: str | None
    description: str | None
    site: str | None
    #: The page's picture as a WebP, drawn anew; ``None`` without one.
    picture: bytes | None = None


class NoCard(Exception):
    """Why there is no card: ``refused`` (an address never asked), ``unreachable``, ``timeout``, ``not_html``,
    ``empty``, ``failed``."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _public(ip: outbound.IP) -> None:
    if not outbound.public(str(ip)):
        raise outbound.Refused("refused")


def check_address(url: str, own_hosts: set[str]) -> str:
    """The address when the server may ask it, else ``NoCard("refused")``."""
    href = safe_href(url)
    if href is None:
        raise NoCard("refused")
    parts = urlsplit(href)
    if parts.scheme.lower() not in ("http", "https") or parts.username or parts.password or not parts.hostname:
        raise NoCard("refused")
    try:
        port = outbound.port_of(href)
    except ValueError as exc:
        raise NoCard("refused") from exc
    host = parts.hostname.lower().rstrip(".")
    if port not in PORTS or host in own_hosts or host == "localhost" or host.endswith((".localhost", ".local")):
        raise NoCard("refused")
    try:
        literal = outbound.ip_of(host.strip("[]"))
    except ValueError:
        literal = None
    if literal is not None and not outbound.public(str(literal)):
        # An address written out: no lookup needed to know it is at home.
        raise NoCard("refused")
    return href


def _host(url: str) -> str:
    return (urlsplit(url).hostname or "").lower()


def _get(session: httpx.Client, url: str, own_hosts: set[str], *, limit: int, accept: Callable[[str], bool],
         deadline: float, ticks: Callable[[], float]) -> tuple[str, httpx.Response]:
    """The answer for ``url``, redirects followed by hand and each address checked again."""
    for _ in range(MAX_REDIRECTS + 1):
        url = check_address(url, own_hosts)
        try:
            place = outbound.pin(url, RESOLVER, _public)
        except outbound.Refused as exc:
            raise NoCard("refused") from exc
        except outbound.Unreachable as exc:
            raise NoCard("unreachable") from exc

        def head(answer: httpx.Response) -> None:
            if answer.is_redirect:
                return
            if answer.status_code != 200 or not accept(answer.headers.get("content-type", "").lower()):
                raise NoCard("not_html")

        try:
            answer = outbound.send(session, "GET", place, {"User-Agent": AGENT, "Accept": "text/html,image/*;q=0.8"},
                                   deadline=deadline, ticks=ticks, limit=limit, connect_seconds=CONNECT_SECONDS,
                                   accept=head)
        except (outbound.Late, httpx.TimeoutException) as exc:
            raise NoCard("timeout") from exc
        except outbound.TooLarge as exc:
            raise NoCard("failed") from exc
        except outbound.Refused as exc:
            raise NoCard("refused") from exc
        except httpx.HTTPError as exc:
            raise NoCard("unreachable") from exc
        if answer.is_redirect:
            target = answer.headers.get("location", "")
            if not target:
                raise NoCard("failed")
            url = urljoin(url, target)
            continue
        return url, answer
    raise NoCard("failed")


class _Head(HTMLParser):
    """Title and the meta tags of a page's head; stops listening at the body."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.meta: dict[str, str] = {}
        self.title = ""
        self._in_title = False
        self.done = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if self.done:
            return
        if tag == "body":
            self.done = True
        elif tag == "title":
            self._in_title = True
        elif tag == "meta":
            values = {key.lower(): value or "" for key, value in attrs}
            key = (values.get("property") or values.get("name") or "").strip().lower()
            if key and "content" in values and key not in self.meta:
                self.meta[key] = values["content"]

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self._in_title = False
        elif tag == "head":
            self.done = True

    def handle_data(self, data: str) -> None:
        if self._in_title and not self.done and len(self.title) < 2000:
            self.title += data


_CHARSET = re.compile(r"charset=[\"']?([\w-]+)", re.IGNORECASE)


def _text_of(answer: httpx.Response) -> str:
    body = answer.content
    found = _CHARSET.search(answer.headers.get("content-type", "")) or _CHARSET.search(
        body[:4096].decode("ascii", "replace"))
    charset = found.group(1) if found else "utf-8"
    try:
        return body.decode(charset, "replace")
    except LookupError:
        return body.decode("utf-8", "replace")


def read_page(text: str) -> dict[str, str | None]:
    """Title, description, site and picture address of a page's HTML."""
    head = _Head()
    try:
        head.feed(text)
    except Exception as exc:  # noqa: BLE001 - a broken page has what was read up to the break
        logger.debug("A page could not be read to its end: %s", type(exc).__name__)
    meta = head.meta

    def first(*keys: str) -> str | None:
        for key in keys:
            value = meta.get(key)
            if value and value.strip():
                return html.unescape(value)
        return None

    return {
        "title": first("og:title", "twitter:title") or (head.title.strip() or None),
        "description": first("og:description", "twitter:description", "description"),
        "site": first("og:site_name"),
        "picture": first("og:image:secure_url", "og:image", "og:image:url", "twitter:image", "twitter:image:src"),
    }


def _picture(data: bytes) -> bytes | None:
    if avatars.sniff(data[:64]) not in PICTURE_KINDS:
        return None
    try:
        from PIL import Image

        with Image.open(io.BytesIO(data)) as image:
            if image.width * image.height > 40_000_000:
                return None
            image.thumbnail((PICTURE_EDGE, PICTURE_EDGE), Image.Resampling.LANCZOS)
            picture: Any = image.convert("RGBA" if image.mode in ("RGBA", "LA", "P") else "RGB")
            out = io.BytesIO()
            picture.save(out, "WEBP", quality=80, method=4, exif=b"", xmp=b"")
            return out.getvalue()
    except Exception:  # noqa: BLE001 - a broken picture means a card without one
        return None


def fetch(url: str, own_hosts: set[str], *, ticks: Callable[[], float] = time.monotonic) -> Card:
    """The card of the page at ``url``; ``NoCard`` with the reason when there is none."""
    href = check_address(url, own_hosts)
    started = ticks()
    try:
        with outbound.client(TRANSPORT) as session:
            final, answer = _get(session, href, own_hosts, limit=MAX_PAGE, deadline=started + SECONDS, ticks=ticks,
                                 accept=lambda kind: kind.startswith(("text/html", "application/xhtml+xml")))
            found = read_page(_text_of(answer))
            title = clean_label(found["title"], s.MAX_CARD_TITLE)
            if not title:
                raise NoCard("empty")
            picture = None
            address = found["picture"]
            if address:
                try:
                    _, image = _get(session, urljoin(final, address), own_hosts, limit=MAX_PICTURE,
                                    deadline=ticks() + SECONDS, ticks=ticks,
                                    accept=lambda kind: kind.startswith("image/"))
                    picture = _picture(image.content)
                except NoCard:
                    picture = None
    except NoCard as exc:
        logger.info("No link card host=%s reason=%s", _host(href), exc.reason)
        raise
    site = clean_label(found["site"], s.MAX_NAME) or _host(href).removeprefix("www.")
    logger.info("Link card made host=%s picture=%s", _host(href), picture is not None)
    return Card(href=href, title=title, description=clean_label(found["description"], s.MAX_CARD_TEXT), site=site,
                picture=picture)

"""A member's own nextasks (NOTES-19): connecting it, its lists, a line sent as a task, the mark beside the line.

nexnotes speaks nextasks' ``/api/v1`` (``nextasks/docs/api.md``) with the member's API token (``ntk_…``) in
``Authorization: Bearer`` and never an ``Origin``, as nexmail does (``nexmail/backend/app/services/nextasks.py``).

* **``/me`` first (AC-5, EC-7).** A token that only reads, or a nextasks whose ``features`` lack ``tasks`` and
  ``external_ref``, or one without ``/api/v1`` at all, is refused while connecting, not at the first task sent.
* **``external_ref`` makes sending safe to repeat (EC-6).** Each line of one sending carries
  ``nexnotes:<account>:<sending>:<n>``; nextasks answers the same key with the task it made before, also when two
  calls come at once. nexnotes keeps one mark per sending and line.
* **The address is checked at every request.** A member types it, and nextasks mostly runs in the home network. As
  in nexmail: an address in the operator's own network only when the operator allowed it
  (``connections_local_network``), the machine itself and the special addresses never; the name is resolved once and
  the connection goes to exactly what was checked (``outbound.pin``), no redirect is followed, the answer is read up
  to a size and within a deadline.
* **The token is stored sealed** with the server's key (``security.encrypt_secret``), never logged, never answered.
  No body of nextasks' answers reaches the log, only status and code: task texts stand in them.
* **Errors are codes, never 401** (that means "signed out" in the interface). Whatever goes wrong on the way (no
  answer, too late, a redirect, an answer nexnotes cannot use) is one code for the caller, ``nextasks_unreachable``;
  the details go to the log only. Otherwise a member could map ports and services from the server's place.
* **Ports below 1024 only 80 and 443**, and **a brake per account**: few connects a minute, a few dozen other
  requests, at most ``AT_ONCE`` running at the same time. A request to a slow address holds a worker of the server.
"""

from __future__ import annotations

import ipaddress
import json as jsonlib
import logging
import re
import threading
import time
from collections import defaultdict, deque
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import date
from typing import Any, NoReturn
from urllib.parse import urlsplit

import httpx
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..errors import detail
from ..models import utcnow
from ..models_nextasks import NextasksConnection, NextasksLink
from ..security import decrypt_secret, encrypt_secret
from . import outbound, settings_service

logger = logging.getLogger("nexnotes.nextasks")

#: A person waits in front of the dialog: short.
SECONDS = 10.0
CONNECT_SECONDS = 3.0
#: The largest answer read (the lists of a big household fit many times).
MAX_ANSWER = 2 * 1024 * 1024
MAX_URL = 500
MAX_TOKEN = 500
MAX_TITLE = 500
#: What nextasks takes in ``notes`` and ``external_ref``.
MAX_NOTES = 20_000
MAX_REF = 200
#: Lines one sending may hold (EC-2).
MAX_LINES = 50
#: The features a nextasks must name in ``/me``.
FEATURES = ("tasks", "external_ref")
#: Between list and section in a list choice (nextasks' ids are UUIDs, without a slash).
SECTION = "/"
AGENT = "nexnotes"
#: Ports below 1024 that may be asked: the web's own. Others there are mail, SSH, databases, never nextasks.
LOW_PORTS = (80, 443)
#: Requests to nextasks an account may start in a minute: connecting (a new address each time) is the rarer one.
CONNECTS_PER_MINUTE = 5
REQUESTS_PER_MINUTE = 30
#: Requests to nextasks of one account running at the same time.
AT_ONCE = 2
#: The operator's switch for addresses in the own network.
LOCAL_SWITCH = "connections_local_network"

#: The own network: private ranges, carrier-grade NAT (Tailscale and other VPNs), unique-local and site-local IPv6.
LOCAL_NETWORKS = tuple(ipaddress.ip_network(net) for net in (
    "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "fc00::/7", "fec0::/10",
))
#: Names that are the machine itself (in a container: nexnotes, not the host nextasks runs on).
OWN_NAMES = ("localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback")

ANCHOR = re.compile(r"^\d{1,20}\.\d{1,20}$")
REQUEST = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
LIST_ID = re.compile(r"^[A-Za-z0-9-]{1,64}(/[A-Za-z0-9-]{1,64})?$")
#: An area of nextasks (a space), and the marks of an area or a list as nextasks stores them.
AREA_ID = re.compile(r"^[A-Za-z0-9-]{1,100}$")
SYMBOL = re.compile(r"^[a-z0-9-]{1,40}$")
COLOR = re.compile(r"^([a-z]{1,20}|#[0-9a-fA-F]{6})$")
#: At most so many areas, and single lists chosen.
MAX_AREAS = 200
MAX_CHOSEN = 500
#: How long the areas are kept for the choice in Connections.
AREAS_SECONDS = 60.0

#: Stand-ins for the tests: how a name is resolved, and the transport (``None``: the network).
RESOLVER = outbound.resolve
TRANSPORT: httpx.BaseTransport | None = None


class NextasksError(Exception):
    """A refusal with its code, its HTTP status for the interface and values for the sentence."""

    def __init__(self, code: str, message: str, status: int = 502, *, headers: dict[str, str] | None = None,
                 **values: Any) -> None:
        super().__init__(code)
        self.code = code
        self.message = message
        self.status = status
        self.headers = headers
        self.values = values

    def http(self, **more: Any) -> Exception:
        return HTTPException(status_code=self.status, detail=detail(self.code, self.message, **self.values, **more),
                             headers=self.headers)


def _unreachable(reason: str, *args: Any) -> NextasksError:
    """Every way a request goes wrong, as the caller hears it: one code. Which way it was goes to the log only, so
    that nobody maps ports or services from the server's place (open, closed, slow, something else answering)."""
    logger.info("nextasks gave no usable answer: " + reason, *args)
    return NextasksError("nextasks_unreachable", "nextasks cannot be reached or gave no usable answer.", 502)


# --- The brake ------------------------------------------------------------------------------------------------------

_gate_lock = threading.Lock()
_started: dict[tuple[int, bool], deque[float]] = defaultdict(deque)
_running: dict[int, int] = defaultdict(int)
#: The areas and lists of an account's nextasks, for the choice in Connections: (when, areas, lists).
_areas_lock = threading.Lock()
_areas_cache: dict[int, tuple[float, dict[str, dict[str, Any]], list[dict[str, Any]]]] = {}


@contextmanager
def outgoing(account_id: int, *, connecting: bool = False, now: float | None = None) -> Iterator[None]:
    """Room for one request of an account to nextasks (or one sending, which asks once per line): under the brake of a
    minute (``CONNECTS_PER_MINUTE`` for connecting, ``REQUESTS_PER_MINUTE`` else) and ``AT_ONCE`` at the same time.
    Refused with 429 ``slow_down`` or ``nextasks_busy``."""
    now = time.monotonic() if now is None else now
    limit = CONNECTS_PER_MINUTE if connecting else REQUESTS_PER_MINUTE
    with _gate_lock:
        seen = _started[(account_id, connecting)]
        while seen and now - seen[0] > 60:
            seen.popleft()
        if len(seen) >= limit:
            wait = max(1, int(60 - (now - seen[0])) + 1)
            logger.info("nextasks brake account_id=%s connecting=%s", account_id, connecting)
            raise NextasksError("slow_down", "Too many requests to nextasks. Wait a minute.", 429,
                                headers={"Retry-After": str(wait)})
        if _running[account_id] >= AT_ONCE:
            raise NextasksError("nextasks_busy", "Requests to nextasks are running already. Wait a moment.", 429,
                                headers={"Retry-After": "2"})
        seen.append(now)
        _running[account_id] += 1
    try:
        yield
    finally:
        with _gate_lock:
            _running[account_id] -= 1
            if _running[account_id] <= 0:
                del _running[account_id]


def forget() -> None:
    with _gate_lock:
        _started.clear()
        _running.clear()
    with _areas_lock:
        _areas_cache.clear()


# --- The address ----------------------------------------------------------------------------------------------------


def clean_url(raw: str) -> str:
    """The address in its form, without resolving: http(s), a host, no credentials, query or fragment; a path is
    allowed (nextasks behind a sub-path). The machine itself by name is never one."""
    url = (raw or "").strip().rstrip("/")
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError as exc:
        raise NextasksError("nextasks_address_invalid", "This is not an address of nextasks.", 422) from exc
    if (len(url) > MAX_URL or parts.scheme not in ("http", "https") or not parts.hostname or parts.query
            or parts.fragment or parts.username or parts.password or (port is not None and not 0 < port < 65536)):
        raise NextasksError("nextasks_address_invalid", "This is not an address of nextasks.", 422)
    if port is not None and port < 1024 and port not in LOW_PORTS:
        raise NextasksError("nextasks_address_port", "nexnotes asks nextasks on port 80, 443 or from 1024 on.", 422)
    host = parts.hostname.lower().rstrip(".")
    if host in OWN_NAMES or host.endswith(".localhost"):
        raise NextasksError("nextasks_address_refused", "nexnotes never asks this address.", 422)
    return url


def _local(ip: outbound.IP) -> bool:
    return any(ip in net for net in LOCAL_NETWORKS if ip.version == net.version)


def address_rule(local_allowed: bool) -> Any:
    """The rule for each address a name resolves to (``outbound.pin`` refuses the ones never reached first)."""

    def rule(ip: outbound.IP) -> None:
        for one in outbound.inner(ip):
            if one.is_loopback:
                raise outbound.Refused("refused")
            if outbound.public(str(one)):
                continue
            if _local(one):
                if not local_allowed:
                    raise outbound.Refused("local")
                continue
            raise outbound.Refused("refused")

    return rule


def local_allowed(db: Session) -> bool:
    return bool(settings_service.get(db, LOCAL_SWITCH))


# --- Talking to nextasks --------------------------------------------------------------------------------------------


@dataclass
class Access:
    url: str
    token: str
    #: The operator's switch at the time of asking.
    local: bool


def _code(answer: httpx.Response) -> tuple[str, list[Any]]:
    try:
        data = answer.json()
    except ValueError:
        return "", []
    detail = data.get("detail") if isinstance(data, dict) else None
    if not isinstance(detail, dict):
        return "", []
    fields = detail.get("fields")
    return str(detail.get("code") or ""), fields if isinstance(fields, list) else []


def _refusal(answer: httpx.Response, method: str, path: str) -> NoReturn:
    status = answer.status_code
    code, fields = _code(answer)
    logger.info("nextasks answered HTTP %s (%s) on %s %s", status, code or "-", method, path.split("/")[0])
    if status == 401 and code == "api_off":
        raise NextasksError("nextasks_api_off", "The operator of nextasks has switched API tokens off.", 409)
    if status == 401:
        raise NextasksError("nextasks_token_invalid", "nextasks does not take this key.", 409)
    if status == 403 and code == "token_reads_only":
        raise NextasksError("nextasks_read_only", "This key of nextasks may only read.", 409)
    if status == 403 and code == "not_allowed":
        raise NextasksError("nextasks_list_unknown", "nextasks does not let this key write into the list.", 409)
    if status == 404:
        raise NextasksError("nextasks_not_found", "nextasks does not know this.", 404)
    if status == 422 and "list_id" in fields:
        raise NextasksError("nextasks_list_unknown", "nextasks does not know the list.", 409)
    if status == 429:
        wait = answer.headers.get("retry-after", "")
        seconds = int(wait) if wait.isdigit() and 0 < int(wait) < 86_400 else 60
        raise NextasksError("nextasks_slow_down", "nextasks asks for fewer requests.", 429, seconds=seconds)
    raise _unreachable("an answer nexnotes cannot use (HTTP %s)", status)


def request(access: Access, method: str, path: str, *, params: dict[str, str] | None = None,
            body: dict[str, Any] | None = None) -> Any:
    """``<address>/api/v1/<path>`` with the token; the JSON of the answer, every failure as ``NextasksError``."""
    if not access.token:
        raise NextasksError("nextasks_not_connected", "nextasks is not connected.", 409)
    url = clean_url(access.url) + "/api/v1/" + path
    try:
        place = outbound.pin(url, RESOLVER, address_rule(access.local))
    except outbound.Refused as exc:
        if exc.reason == "local":
            raise NextasksError("nextasks_address_local",
                                "This address is in the own network; the operator has not allowed that.", 422) from exc
        raise NextasksError("nextasks_address_refused", "nexnotes never asks this address.", 422) from exc
    except outbound.Unreachable as exc:
        raise _unreachable("the name does not resolve") from exc
    headers = {"Authorization": f"Bearer {access.token}", "User-Agent": AGENT, "Accept": "application/json"}
    sent: dict[str, Any] = {}
    if params:
        sent["params"] = params
    if body is not None:
        sent["content"] = jsonlib.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    try:
        with outbound.client(TRANSPORT) as session:
            answer = outbound.send(session, method, place, headers, deadline=time.monotonic() + SECONDS,
                                   ticks=time.monotonic, limit=MAX_ANSWER, connect_seconds=CONNECT_SECONDS, **sent)
    except (outbound.Late, httpx.TimeoutException) as exc:
        raise _unreachable("no answer in time") from exc
    except outbound.TooLarge as exc:
        raise _unreachable("an answer larger than %s bytes", MAX_ANSWER) from exc
    except (outbound.Refused, httpx.HTTPError, OSError) as exc:
        raise _unreachable("no connection (%s)", type(exc).__name__) from exc
    if answer.status_code >= 300:
        # A redirect counts as a refusal: nexnotes follows none.
        _refusal(answer, method, path)
    try:
        return answer.json()
    except ValueError as exc:
        raise _unreachable("an answer that is no JSON") from exc


def check(access: Access) -> str:
    """``GET /me``: the token holds, may write, and nextasks offers what nexnotes needs. The name nextasks gives."""
    try:
        me = request(access, "GET", "me")
    except NextasksError as exc:
        if exc.code == "nextasks_not_found":
            # No ``/api/v1``: a nextasks from before the API (or after it moved to another one), or no nextasks.
            raise NextasksError("nextasks_too_old", "This nextasks speaks another API than nexnotes.", 409) from exc
        raise
    features = me.get("features") if isinstance(me, dict) else None
    if not isinstance(features, list) or not all(feature in features for feature in FEATURES):
        raise NextasksError("nextasks_too_old", "This nextasks speaks another API than nexnotes.", 409)
    if me.get("level") != "write":
        raise NextasksError("nextasks_read_only", "This key of nextasks may only read.", 409)
    return str(me.get("display_name") or me.get("name") or "")[:200]


def _list_rows(access: Access) -> list[dict[str, Any]]:
    """``GET /lists`` as nexnotes uses it, in nextasks' order: the lists the token may write into, each with its area
    (nextasks' space), symbol, colour and sections."""
    data = request(access, "GET", "lists")
    rows = data.get("lists") if isinstance(data, dict) else None
    if not isinstance(rows, list):
        raise _unreachable("an answer of another form")
    found: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("id"), str) or not LIST_ID.match(row["id"]):
            continue
        if row.get("writable") is False or SECTION in row["id"]:
            continue
        area = row.get("space_id") if isinstance(row.get("space_id"), str) and AREA_ID.match(row["space_id"]) else ""
        found.append({
            "id": row["id"], "area": area, "area_name": _text(row.get("space_name"), 100),
            "name": _text(row.get("name"), 100), "hidden": row.get("hidden") is True,
            "icon": _mark(row.get("icon"), SYMBOL), "color": _mark(row.get("color"), COLOR),
            "sections": [{"id": section["id"], "name": _text(section.get("name"), 100)}
                         for section in row.get("sections") or []
                         if isinstance(section, dict) and isinstance(section.get("id"), str)
                         and LIST_ID.match(section["id"]) and SECTION not in section["id"]],
        })
    return found


def _text(value: Any, size: int) -> str:
    return str(value)[:size] if value is not None else ""


def _mark(value: Any, rule: re.Pattern[str]) -> str:
    return value if isinstance(value, str) and rule.match(value) else ""


def _flat(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The lists for the sending, each with its sections after it, as "Area › List (› Section)"; those of
    hidden areas at the end."""
    found: list[dict[str, Any]] = []
    for row in rows:
        name = " › ".join(part for part in (row["area_name"], row["name"]) if part)
        found.append({"id": row["id"], "name": name, "hidden": row["hidden"]})
        for section in row["sections"]:
            found.append({"id": f"{row['id']}{SECTION}{section['id']}", "name": f"{name} › {section['name']}",
                          "hidden": row["hidden"]})
    return sorted(found, key=lambda one: one["hidden"])


# --- Areas and lists chosen, the standard list ("Bereiche und Listen" in Connections) -----------------------------


def choice_of(row: NextasksConnection) -> dict[str, set[str]] | None:
    """The areas chosen whole and the single lists; ``None``: nothing chosen yet, every area whole."""
    try:
        found = jsonlib.loads(row.task_choice) if row.task_choice else None
    except ValueError:
        found = None
    if not isinstance(found, dict):
        return None
    return {name: {one for one in found.get(name) or [] if isinstance(one, str)} for name in ("areas", "lists")}


def _chosen(choice: dict[str, set[str]] | None, list_row: dict[str, Any]) -> bool:
    # A list without an area (a nextasks before its spaces) cannot be chosen away: it is always offered.
    if choice is None or not list_row["area"]:
        return True
    return list_row["area"] in choice["areas"] or list_row["id"] in choice["lists"]


def _default(row: NextasksConnection, rows: list[dict[str, Any]]) -> str | None:
    """The standard list while it is chosen and nextasks still has it; otherwise none, quietly."""
    choice = choice_of(row)
    wanted = row.default_list_id
    return wanted if wanted and any(one["id"] == wanted and _chosen(choice, one) for one in rows) else None


def offered(db: Session, account_id: int) -> dict[str, Any]:
    """The lists the sending offers (web and app): the chosen ones with their sections, the standard list marked
    ``default``; and the list used last while it is among them."""
    access = connected_access(db, account_id)
    with outgoing(account_id):
        rows = _list_rows(access)
    row = connection_of(db, account_id)
    if row is None:
        raise NextasksError("nextasks_not_connected", "nextasks is not connected.", 409)
    choice = choice_of(row)
    standard = _default(row, rows)
    found = [{**one, "default": one["id"] == standard} for one in _flat([one for one in rows if _chosen(choice, one)])]
    last = row.last_list_id if any(one["id"] == row.last_list_id for one in found) else ""
    return {"lists": found, "last": last or None}


def _areas(access: Access, account_id: int) -> tuple[dict[str, dict[str, Any]], list[dict[str, Any]]]:
    """The areas (nextasks' spaces) with symbol and colour in nextasks' order, and the lists; kept a minute, so ticking
    one box after another asks nextasks once. A nextasks without ``/spaces`` names its areas by the lists."""
    with _areas_lock:
        kept = _areas_cache.get(account_id)
    if kept and time.monotonic() - kept[0] < AREAS_SECONDS:
        return kept[1], kept[2]
    rows = _list_rows(access)
    try:
        spaces = request(access, "GET", "spaces")
    except NextasksError as exc:
        if exc.code != "nextasks_not_found":
            raise
        spaces = {}
    named: dict[str, dict[str, Any]] = {}
    for one in (spaces.get("spaces") if isinstance(spaces, dict) else None) or []:
        if isinstance(one, dict) and isinstance(one.get("id"), str) and AREA_ID.match(one["id"]):
            named[one["id"]] = {"id": one["id"], "name": _text(one.get("name"), 100),
                                "icon": _mark(one.get("icon"), SYMBOL), "color": _mark(one.get("color"), COLOR)}
    areas: dict[str, dict[str, Any]] = {}
    for one in rows:
        if one["area"] and one["area"] not in areas:
            areas[one["area"]] = named.get(one["area"]) or {"id": one["area"], "name": one["area_name"], "icon": "",
                                                             "color": ""}
    areas = dict(list(areas.items())[:MAX_AREAS])
    with _areas_lock:
        _areas_cache[account_id] = (time.monotonic(), areas, rows)
    return areas, rows


def areas_out(db: Session, account_id: int) -> dict[str, Any]:
    """Every area with its lists, in nextasks' order: whether the area is chosen whole and which lists alone; and the
    standard list while it counts (``None`` otherwise, never an error)."""
    access = connected_access(db, account_id)
    with outgoing(account_id):
        areas, rows = _areas(access, account_id)
    row = connection_of(db, account_id)
    if row is None:
        raise NextasksError("nextasks_not_connected", "nextasks is not connected.", 409)
    choice = choice_of(row)
    out = []
    for area_id, area in areas.items():
        whole = choice is None or area_id in choice["areas"]
        single = set() if choice is None else choice["lists"]
        out.append({**area, "whole": whole,
                    "lists": [{"id": one["id"], "name": one["name"], "icon": one["icon"], "color": one["color"],
                               "chosen": whole or one["id"] in single}
                              for one in rows if one["area"] == area_id]})
    return {"areas": out, "default": _default(row, rows)}


def choose(db: Session, account_id: int, areas: list[str], lists: list[str], default: str | None) -> dict[str, Any]:
    """Keeps the areas chosen whole, the single lists and the standard list; a standard list not among the chosen
    ones counts as none from here on (ticked again later, it stays none)."""
    row = connection_of(db, account_id)
    if row is None:
        raise NextasksError("nextasks_not_connected", "nextasks is not connected.", 409)
    row.task_choice = jsonlib.dumps({"areas": sorted({one for one in areas if AREA_ID.match(one)})[:MAX_AREAS],
                                     "lists": sorted({one for one in lists if LIST_ID.match(one)})[:MAX_CHOSEN]})
    row.default_list_id = default if default and LIST_ID.match(default) and SECTION not in default else ""
    db.commit()
    found = areas_out(db, account_id)
    if row.default_list_id and found["default"] is None:
        row.default_list_id = ""
        db.commit()
    return found


def _link_of(value: Any) -> str:
    # Only http(s): the link becomes an ``href`` in the interface.
    if isinstance(value, str) and len(value) <= 2000 and urlsplit(value).scheme in ("http", "https"):
        return value
    return ""


def create_task(access: Access, *, title: str, note_url: str, note_title: str, list_id: str, due: date | None,
                ref: str) -> dict[str, Any]:
    """One task (``POST /tasks``): its id and link. The same ``ref`` again gives the task made before."""
    back = f"From nexnotes: [{_markdown_text(note_title) or note_url}]({note_url})"
    body: dict[str, Any] = {"title": title[:MAX_TITLE], "url": note_url, "external_ref": ref[:MAX_REF],
                            "notes": back[:MAX_NOTES]}
    list_part, _, section = list_id.partition(SECTION)
    if list_part:
        body["list_id"] = list_part
    if section:
        body["section_id"] = section
    if due is not None:
        body["due_date"] = due.isoformat()
    try:
        task = request(access, "POST", "tasks", body=body)
    except NextasksError as exc:
        if exc.code == "nextasks_not_found":
            # nextasks answers a list the token cannot see with 404 (measured by nexmail on 07.11.2026).
            raise NextasksError("nextasks_list_unknown", "nextasks does not know the list.", 409) from exc
        raise
    if not isinstance(task, dict) or not isinstance(task.get("id"), str) or not task["id"]:
        raise _unreachable("an answer of another form")
    return {"id": task["id"][:100], "link": _link_of(task.get("link"))}


def _markdown_text(text: str) -> str:
    """A title inside the brackets of a Markdown link: brackets and backslashes escaped, one line."""
    return re.sub(r"([\\\[\]])", r"\\\1", " ".join(text.split()))[:300]


def task_state(access: Access, task_id: str) -> dict[str, Any]:
    """How nextasks sees a task now: ``gone`` (deleted for good, or in its trash) or its current link (EC-4)."""
    if not re.fullmatch(r"[A-Za-z0-9-]{1,100}", task_id):
        return {"gone": True, "trashed": False, "link": ""}
    try:
        task = request(access, "GET", f"tasks/{task_id}")
    except NextasksError as exc:
        if exc.code == "nextasks_not_found":
            return {"gone": True, "trashed": False, "link": ""}
        raise
    if not isinstance(task, dict):
        raise _unreachable("an answer of another form")
    trashed = task.get("trashed") is True
    return {"gone": trashed, "trashed": trashed, "link": _link_of(task.get("link"))}


# --- The connection -------------------------------------------------------------------------------------------------


def _context(account_id: int) -> str:
    return f"nextasks:{account_id}"


def connection_of(db: Session, account_id: int) -> NextasksConnection | None:
    """The account's connection; one a paired device made goes with that device (NOTESIOS-22 AC-7): disconnected,
    blocked, or the account's devices all signed out, its key opens nothing any more."""
    row = db.get(NextasksConnection, account_id)
    if row is not None and row.device_id is not None:
        from ..models import TOKEN_DEVICE, ApiToken

        token = db.get(ApiToken, row.device_id)
        gone = token is None or token.kind != TOKEN_DEVICE or token.account_id != account_id
        if gone or token.blocked_at is not None:
            db.delete(row)
            db.commit()
            logger.info("nextasks connection of a gone device dropped account_id=%s", account_id)
            return None
    return row


def access_of(db: Session, row: NextasksConnection) -> Access:
    return Access(url=row.url, token=decrypt_secret(row.token_enc, _context(row.account_id)), local=local_allowed(db))


def connected_access(db: Session, account_id: int) -> Access:
    row = connection_of(db, account_id)
    if row is None:
        raise NextasksError("nextasks_not_connected", "nextasks is not connected.", 409)
    access = access_of(db, row)
    if not access.token:
        # A server key changed since: the token is lost, the member connects again.
        raise NextasksError("nextasks_token_invalid", "nextasks does not take this key.", 409)
    return access


def connect(db: Session, account_id: int, url: str, token: str, *, device_id: int | None = None) -> NextasksConnection:
    """Checks address and token at once (AC-5, EC-7) and keeps them only when they hold. ``device_id``: a paired
    device connects (NOTESIOS-22 AC-7); the connection lives as long as that device does."""
    token = (token or "").strip()
    if not token or len(token) > MAX_TOKEN or any(ord(char) < 33 or ord(char) > 126 for char in token):
        raise NextasksError("nextasks_token_invalid", "nextasks does not take this key.", 409)
    clean = clean_url(url)
    name = check(Access(url=clean, token=token, local=local_allowed(db)))
    row = connection_of(db, account_id)
    if row is None:
        row = NextasksConnection(account_id=account_id, url=clean, token_enc="")
        db.add(row)
    if row.url != clean:
        # Another nextasks has other lists: what was chosen of the one before counts no more.
        row.last_list_id, row.last_list_name = "", ""
        row.task_choice, row.default_list_id = "", ""
    with _areas_lock:
        _areas_cache.pop(account_id, None)
    row.url = clean
    row.token_enc = encrypt_secret(token, _context(account_id))
    row.name = name
    row.checked_at = utcnow()
    row.device_id = device_id
    db.commit()
    logger.info("nextasks connected account_id=%s host=%s device=%s", account_id, urlsplit(clean).hostname,
                device_id is not None)
    return row


def disconnect(db: Session, account_id: int) -> None:
    row = connection_of(db, account_id)
    if row is not None:
        db.delete(row)
        db.commit()
        logger.info("nextasks disconnected account_id=%s", account_id)


def connection_out(db: Session, row: NextasksConnection | None) -> dict[str, Any]:
    allowed = local_allowed(db)
    if row is None:
        return {"connected": False, "local_allowed": allowed}
    return {
        "connected": True,
        "url": row.url,
        "host": urlsplit(row.url).hostname or "",
        "name": row.name,
        "checked_at": row.checked_at.isoformat() if row.checked_at else None,
        "last_list": {"id": row.last_list_id, "name": row.last_list_name} if row.last_list_id else None,
        "local_allowed": allowed,
    }


# --- Sending and the marks ------------------------------------------------------------------------------------------


@dataclass
class Line:
    text: str
    anchor: str


def ref_for(account_id: int, request_id: str, position: int) -> str:
    return f"nexnotes:{account_id}:{request_id}:{position}"


def link_out(row: NextasksLink) -> dict[str, Any]:
    return {
        "id": row.id,
        "note_id": row.note_id,
        "anchor": row.anchor,
        "task_url": row.task_url,
        "list_name": row.list_name,
        "due_date": row.due_date.isoformat() if row.due_date else None,
        "created_at": row.created_at.isoformat() if row.created_at else None,
    }


def links_of(db: Session, account_id: int, note_id: str) -> list[NextasksLink]:
    """Only the account's own marks (EC-5): another member of the note sees none of them."""
    return list(db.scalars(select(NextasksLink).where(NextasksLink.account_id == account_id,
                                                      NextasksLink.note_id == note_id).order_by(NextasksLink.id)))


def send(db: Session, account_id: int, *, note_id: str, note_title: str, note_url: str, request_id: str,
         list_id: str, list_name: str, due: date | None, lines: list[Line]) -> list[NextasksLink]:
    """One task per line (EC-2), each with the way back to the note (AC-2); a mark per line once nextasks made it.
    A sending again (a second click, a retry after a failure) makes no second task and no second mark (EC-6). On a
    failure the lines sent before keep their marks, and the error names how many went."""
    access = connected_access(db, account_id)
    made: list[NextasksLink] = []
    for position, line in enumerate(lines):
        existing = db.scalar(select(NextasksLink).where(NextasksLink.account_id == account_id,
                                                        NextasksLink.request_id == request_id,
                                                        NextasksLink.position == position))
        if existing is not None:
            made.append(existing)
            continue
        try:
            task = create_task(access, title=line.text, note_url=note_url, note_title=note_title, list_id=list_id,
                               due=due, ref=ref_for(account_id, request_id, position))
        except NextasksError as exc:
            exc.values["sent"] = len(made)
            raise
        row = NextasksLink(account_id=account_id, note_id=note_id, request_id=request_id, position=position,
                           anchor=line.anchor, task_id=task["id"], task_url=task["link"], list_name=list_name[:300],
                           due_date=due)
        db.add(row)
        try:
            db.commit()
        except IntegrityError:
            # The same sending at the same moment made it: that one counts.
            db.rollback()
            row = db.scalar(select(NextasksLink).where(NextasksLink.account_id == account_id,
                                                       NextasksLink.request_id == request_id,
                                                       NextasksLink.position == position))
            assert row is not None
        made.append(row)
    connection = connection_of(db, account_id)
    if connection is not None:
        connection.last_list_id, connection.last_list_name = list_id, list_name[:300]
        db.commit()
    logger.info("Lines sent to nextasks note=%s count=%s account_id=%s", note_id, len(made), account_id)
    return made

"""Notifications for the iOS app through the push relay (``https://push.nexapps.dev``), as in nextasks and nexmail
(``services/push.py`` there; the relay's interface is in its README).

The app keeps an X25519 key pair per server and hands the relay's ticket and its public key over when it signs up
for notifications (NOTES-24 AC-6, which brings the way in: ``remember``). A notification is compact JSON
``{"title", "text", "note_id", "at", "type"}``, encrypted for exactly that device: a fresh X25519 pair and nonce per
message, HKDF-SHA256 with the info ``nexnotes-push-v1``, ChaCha20-Poly1305 (``services/push_crypto.py``). The relay and
Apple only ever see the ciphertext (NOTES-14 AC-6). The alert's own keys (``push_title``, ``push_body``) are strings of
the app and say nothing about the note.

Only 410 from the relay drops the ticket (EC-4; the app brings a new one); any other failure leaves it, and the
outbox tries again (EC-2). What went wrong is logged without the ticket.
"""

from __future__ import annotations

import base64
import binascii
import json
import logging
from collections.abc import Callable

import httpx
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import ApiToken
from ..models_notify import PushDevice
from . import outbound, push_crypto
from .history import clock

logger = logging.getLogger("nexnotes.notify")

TITLE_MAX = 100
TEXT_MAX = 200
#: The relay takes at most this many characters of ``collapse``.
COLLAPSE_MAX = 64
RELAY_SECONDS = 8.0
#: The longest ticket taken (the relay's are far shorter).
TICKET_MAX = 2000


class Failed(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class Gone(Exception):
    """The relay says the ticket is gone (410)."""


def relay_url() -> str:
    """The relay's address; empty: the operator wants nothing to go out."""
    return get_settings().push_relay.strip().rstrip("/")


def key_valid(value: str) -> bool:
    """A public X25519 key one can agree with: 32 bytes, and no point of small order."""
    try:
        raw = base64.b64decode(value, validate=True)
        X25519PrivateKey.generate().exchange(X25519PublicKey.from_public_bytes(raw))
    except (binascii.Error, ValueError):
        return False
    return True


def server_id() -> str:
    """A fixed mark of this server (``me.server_id``), which every notification names so that the app finds the
    account it belongs to (NOTESIOS-15 EC-5): a keyed hash, nothing to learn from it."""
    import hashlib
    import hmac

    from ..security import server_key

    return hmac.new(server_key(), b"nexnotes-server-id", hashlib.sha256).hexdigest()[:16]


def plaintext(message: dict[str, object]) -> bytes:
    """What the app decrypts: compact, the fields in a fixed order. Since interface 0.6 also whose it is
    (``account``, ``server``), who and which note apart (``who``, ``note``, for the app lock) and the place of the
    change (``anchor``)."""
    fields = {"title": str(message.get("title") or "")[:TITLE_MAX], "text": str(message.get("text") or "")[:TEXT_MAX],
              "note_id": message.get("note_id"), "at": message.get("at"), "type": message.get("type") or "changed",
              "account": message.get("account"), "server": server_id(),
              "who": str(message.get("who") or "")[:TITLE_MAX], "note": str(message.get("note") or "")[:TITLE_MAX],
              "anchor": message.get("anchor"), "locked": bool(message.get("locked"))}
    return json.dumps(fields, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def remember(db: Session, account_id: int, token_id: int, ticket: str, key: str) -> PushDevice:
    """Ticket and key of a paired device (its token). The same ticket belongs to one device of the person: a device
    paired again brings its ticket, and the old pairing must not get every message twice. For NOTES-24 AC-6."""
    if not ticket or len(ticket) > TICKET_MAX or not key_valid(key):
        raise ValueError("ticket or key not usable")
    token = db.get(ApiToken, token_id)
    if token is None or token.account_id != account_id:
        raise ValueError("no such device")
    for other in db.scalars(select(PushDevice).where(PushDevice.account_id == account_id,
                                                     PushDevice.token_id != token_id, PushDevice.ticket == ticket)):
        db.delete(other)
    row = db.get(PushDevice, token_id)
    if row is None:
        row = PushDevice(token_id=token_id, account_id=account_id, ticket=ticket, key=key, updated_at=clock.now())
        db.add(row)
    else:
        row.ticket, row.key, row.updated_at = ticket, key, clock.now()
    db.commit()
    return row


def devices(db: Session, account_id: int) -> list[tuple[PushDevice, ApiToken]]:
    """The devices of the account that signed up for notifications, with their tokens (for the name)."""
    return list(db.execute(select(PushDevice, ApiToken).join(ApiToken, ApiToken.id == PushDevice.token_id)
                           .where(PushDevice.account_id == account_id).order_by(ApiToken.name, ApiToken.id))
                .all())


def _post(url: str, body: dict[str, object]) -> int:
    with httpx.Client(timeout=RELAY_SECONDS, verify=outbound.tls(), trust_env=False) as client:
        return client.post(url, json=body).status_code


#: What sends to the relay; the tests put a recorder in its place (nothing goes into the network).
POST: Callable[[str, dict[str, object]], int] = _post


def deliver(device: PushDevice, message: dict[str, object], collapse: str = "") -> None:
    """One message to one device. Raises ``Gone`` (410: the ticket is to go) or ``Failed`` (try again later)."""
    relay = relay_url()
    if not relay:
        raise Failed("no_relay")
    try:
        enc = push_crypto.encrypt(plaintext(message), device.key)
    except ValueError as exc:
        raise Failed("bad_key") from exc
    body: dict[str, object] = {"ticket": device.ticket, "enc": enc}
    if collapse:
        body["collapse"] = collapse[:COLLAPSE_MAX]
    try:
        status = POST(f"{relay}/v1/send", body)
    except (httpx.HTTPError, OSError) as exc:
        raise Failed(type(exc).__name__.lower()[:40]) from exc
    if status == 410:
        raise Gone
    if status != 200:
        raise Failed(f"http_{status}")

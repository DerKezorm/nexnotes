"""Web Push: notifications to a browser, also with the page closed (NOTES-14 AC-7). Taken over from nextasks
(``services/webpush.py``, there from nexdiary).

A browser signs up in the interface (``PUT /api/notify/webpush``): the address at its push service (Google, Apple,
Mozilla, Microsoft) and two keys. nexnotes encrypts every message for that browser (RFC 8291, aes128gcm) and signs the
request with its own key pair (VAPID, RFC 8292): the push service sees that something arrives and for whom, never
what.

**The key pair** is made at the first start and kept in the settings sealed with the server's secret
(``security.encrypt_secret``, context ``operator:vapid``): a backup holds it only sealed. A new pair would mean every
browser signing up again; that happens only when the secret is lost (a backup restored without its ``secret.key``).

**A browser belongs to its session.** The row names the session it was made in; signing out, a new password and the
session's end remove it with the session. Signing in again on the same browser signs it up again (the page does that
by itself while the browser's permission stands).

**Only to push services out in the internet.** The address comes from a browser, so a member could name any: it must
be https and resolve to public addresses only (``outbound.pin``), checked at every send, never a redirect followed.
"""

from __future__ import annotations

import base64
import logging
import os
import threading
import time
from collections.abc import Callable
from urllib.parse import urlsplit

import http_ece
import httpx
import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from sqlalchemy import delete, select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from ..models import Setting
from ..models_notify import WebPushSubscription
from ..security import decrypt_secret, encrypt_secret
from . import outbound, settings_service
from .history import clock

logger = logging.getLogger("nexnotes.notify")

#: How long a push service keeps a message for a browser that is offline: a change of the day before is old news.
TTL_SECONDS = 24 * 3600
VAPID_SECONDS = 12 * 3600
KEY_SETTING = "webpush_key_enc"
KEY_CONTEXT = "operator:vapid"
#: Where nobody set a public https address: well formed, and plainly a placeholder. Apple refuses ``localhost``.
PLACEHOLDER_CONTACT = "mailto:admin@example.com"
#: How many browsers one account may sign up.
MAX_PER_ACCOUNT = 20
#: The longest endpoint taken (the services' own are far shorter).
MAX_ENDPOINT = 1000
#: Seconds one request to a push service may take, answer included.
SEND_SECONDS = 10.0

_lock = threading.Lock()


class Failed(Exception):
    """A browser could not be reached for a reason that may pass (``code`` for the log and the outbox)."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class Gone(Exception):
    """The push service says the subscription is gone (404, 410): the row is removed."""


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def unb64url(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def public_bytes(key: ec.EllipticCurvePrivateKey) -> bytes:
    return key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)


def _load(stored: str) -> ec.EllipticCurvePrivateKey | None:
    pem = decrypt_secret(stored, KEY_CONTEXT)
    if not pem:
        return None
    key = serialization.load_pem_private_key(pem.encode("ascii"), password=None)
    return key if isinstance(key, ec.EllipticCurvePrivateKey) else None


def _sealed_new_key() -> str:
    key = ec.generate_private_key(ec.SECP256R1())
    pem = key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    ).decode("ascii")
    return encrypt_secret(pem, KEY_CONTEXT)


def server_key(db: Session) -> ec.EllipticCurvePrivateKey:
    """The key pair, made at the first need and kept sealed. Two at their first need make one: the second insert finds
    the first and does nothing."""
    with _lock:
        stored = str(settings_service.get(db, KEY_SETTING) or "")
        key = _load(stored) if stored else None
        if key is not None:
            return key
        db.execute(sqlite_insert(Setting).values(key=KEY_SETTING, value=_sealed_new_key())
                   .on_conflict_do_nothing(index_elements=[Setting.key]))
        db.commit()
        key = _load(str(settings_service.get(db, KEY_SETTING) or ""))
        if key is None:
            # Sealed under another secret.key: of no use any more. A new pair; the browsers sign up again.
            logger.warning("The Web Push key could not be read (another secret.key); a new one is made and every "
                           "browser signs up again")
            settings_service.save(db, {KEY_SETTING: _sealed_new_key()})
            db.execute(delete(WebPushSubscription))
            db.commit()
            key = _load(str(settings_service.get(db, KEY_SETTING)))
        assert key is not None
        return key


def public_key(db: Session) -> str:
    return b64url(public_bytes(server_key(db)))


def encrypt(plaintext: bytes, p256dh: str, auth: str) -> bytes:
    return http_ece.encrypt(plaintext, salt=os.urandom(16), private_key=ec.generate_private_key(ec.SECP256R1()),
                            dh=unb64url(p256dh), auth_secret=unb64url(auth), version="aes128gcm")


def vapid_header(key: ec.EllipticCurvePrivateKey, endpoint: str, subject: str) -> str:
    parts = urlsplit(endpoint)
    claims = {"aud": f"{parts.scheme}://{parts.hostname}", "exp": int(time.time() + VAPID_SECONDS), "sub": subject}
    token = jwt.encode(claims, key, algorithm="ES256", headers={"typ": "JWT"})
    return f"vapid t={token}, k={b64url(public_bytes(key))}"


def subject(db: Session) -> str:
    public = settings_service.public_url(db)
    return public if public.startswith("https://") else PLACEHOLDER_CONTACT


def valid_keys(p256dh: str, auth: str) -> bool:
    """A point on P-256, uncompressed, and an auth secret of 16 bytes."""
    try:
        point = unb64url(p256dh)
        secret = unb64url(auth)
    except (ValueError, TypeError):
        return False
    if len(point) != 65 or point[0] != 4 or len(secret) != 16:
        return False
    try:
        ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), point)
    except ValueError:
        return False
    return True


def endpoint_valid(endpoint: str) -> bool:
    """An https address with a name and nothing else in front: the push service's. Where it leads is checked when
    something is sent (``_public``)."""
    if len(endpoint) > MAX_ENDPOINT:
        return False
    parts = urlsplit(endpoint.strip())
    host = (parts.hostname or "").lower()
    return (parts.scheme == "https" and bool(host) and not parts.username and not parts.password
            and host != "localhost" and not host.endswith((".localhost", ".local")))


def subscribe(db: Session, account_id: int, session_id: int, endpoint: str, p256dh: str, auth: str,
              user_agent: str = "") -> WebPushSubscription:
    """One browser, one row: signing up again (also as another account on the same browser) replaces it."""
    db.execute(delete(WebPushSubscription).where(WebPushSubscription.endpoint == endpoint))
    # The same session signing up with a new address (the browser renewed its subscription): the old one goes.
    db.execute(delete(WebPushSubscription).where(WebPushSubscription.session_id == session_id))
    row = WebPushSubscription(account_id=account_id, session_id=session_id, endpoint=endpoint, p256dh=p256dh,
                              auth=auth, user_agent=user_agent[:300], created_at=clock.now())
    db.add(row)
    db.flush()
    rows = list(db.scalars(select(WebPushSubscription).where(WebPushSubscription.account_id == account_id)
                           .order_by(WebPushSubscription.id.desc())))
    for old in rows[MAX_PER_ACCOUNT:]:
        db.delete(old)
    db.commit()
    return row


def unsubscribe(db: Session, account_id: int, session_id: int) -> bool:
    result = db.execute(delete(WebPushSubscription).where(WebPushSubscription.account_id == account_id,
                                                          WebPushSubscription.session_id == session_id))
    db.commit()
    return bool(getattr(result, "rowcount", 0))


def remove(db: Session, account_id: int, subscription_id: int) -> bool:
    """One browser of the account no longer gets notifications (the page Notifications); another account's never."""
    result = db.execute(delete(WebPushSubscription).where(WebPushSubscription.account_id == account_id,
                                                          WebPushSubscription.id == subscription_id))
    db.commit()
    return bool(getattr(result, "rowcount", 0))


def of_session(db: Session, session_id: int) -> WebPushSubscription | None:
    return db.scalar(select(WebPushSubscription).where(WebPushSubscription.session_id == session_id))


def subscriptions(db: Session, account_id: int) -> list[WebPushSubscription]:
    return list(db.scalars(select(WebPushSubscription).where(WebPushSubscription.account_id == account_id)
                           .order_by(WebPushSubscription.id)))


def _public(ip: outbound.IP) -> None:
    if not outbound.public(str(ip)):
        raise outbound.Refused("refused")


def _post(url: str, body: bytes, headers: dict[str, str]) -> int:
    """One request to a push service: resolved once, public addresses only, no redirect, a deadline for all of it."""
    try:
        place = outbound.pin(url, outbound.resolve, _public)
    except outbound.Refused as exc:
        raise Failed("refused") from exc
    except outbound.Unreachable as exc:
        raise Failed("unreachable") from exc
    deadline = time.monotonic() + SEND_SECONDS
    with outbound.client(None) as session:
        answer = outbound.send(session, "POST", place, headers, deadline=deadline, ticks=time.monotonic,
                               limit=64 * 1024, connect_seconds=5.0, content=body)
    return answer.status_code


#: What sends to a push service; the tests put a recorder in its place (nothing goes into the network).
POST: Callable[[str, bytes, dict[str, str]], int] = _post


def deliver(db: Session, row: WebPushSubscription, plaintext: bytes, topic: str = "") -> None:
    """One message to one browser. Raises ``Gone`` (the row is to go) or ``Failed`` (try again later)."""
    headers = {"Authorization": vapid_header(server_key(db), row.endpoint, subject(db)),
               "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", "TTL": str(TTL_SECONDS),
               "Urgency": "normal"}
    if topic:
        headers["Topic"] = "".join(char for char in topic if char.isalnum() or char in "-_")[:32]
    try:
        status = POST(row.endpoint, encrypt(plaintext, row.p256dh, row.auth), headers)
    except Failed:
        raise
    except (httpx.HTTPError, OSError, outbound.Late, outbound.TooLarge) as exc:
        raise Failed(type(exc).__name__.lower()[:40]) from exc
    except ValueError as exc:
        raise Failed("bad_keys") from exc
    if status in (404, 410):
        raise Gone
    if status >= 400:
        raise Failed(f"http_{status}")


# --- The browsers of one account -------------------------------------------------------------------------------------

_BROWSERS = (("Edg/", "Edge"), ("EdgA/", "Edge"), ("EdgiOS/", "Edge"), ("OPR/", "Opera"),
             ("SamsungBrowser/", "Samsung Internet"), ("Firefox/", "Firefox"), ("FxiOS/", "Firefox"),
             ("CriOS/", "Chrome"), ("Chrome/", "Chrome"), ("Chromium/", "Chromium"), ("Safari/", "Safari"))
_SYSTEMS = (("iPhone", "iOS"), ("iPad", "iPadOS"), ("Android", "Android"), ("Windows", "Windows"),
            ("CrOS", "ChromeOS"), ("Mac OS X", "macOS"), ("Macintosh", "macOS"), ("Linux", "Linux"))


def describe(user_agent: str) -> tuple[str, str]:
    """Browser and system from a ``User-Agent`` (``("Chrome", "Windows")``); empty where it says nothing known."""
    browser = next((name for mark, name in _BROWSERS if mark in user_agent), "")
    system = next((name for mark, name in _SYSTEMS if mark in user_agent), "")
    return browser, system

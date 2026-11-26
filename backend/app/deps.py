"""Who is asking.

Every route under ``/api`` except setup, sign-in, invitations, the public reading pages, languages and health needs
the session cookie. Changing requests need ``X-Nexnotes-Client`` on top (``GuardMiddleware``): a page on another site
can make a browser send a form with the cookie, but not a request with a header of its own.
"""

from __future__ import annotations

import ipaddress
import logging
from functools import lru_cache
from typing import Annotated

from fastapi import Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import get_settings
from .db import SessionLocal, get_db
from .errors import detail, error
from .models import OPERATOR, SIGN_IN_PASSWORD, TOKEN_DEVICE, AuthSession, OidcLink, OidcProvider, utcnow
from .models import Account as AccountRow
from .security import SESSION_COOKIE, account_out, hash_token, session_account, session_owner
from .services import accounts, apitokens, logs, totp
from .vendor.nexkonten.brake import BRAKE, DOOR_CONFIRM, door_key
from .vendor.nexkonten.common import FRESH_SIGN_IN_MINUTES, fresh_sign_in

DbSession = Annotated[Session, Depends(get_db)]

logger = logging.getLogger("nexnotes.auth")


@lru_cache(maxsize=4)
def _trusted_networks(spec: str) -> tuple[ipaddress.IPv4Network | ipaddress.IPv6Network, ...]:
    networks = []
    for entry in spec.split(","):
        entry = entry.strip()
        if not entry:
            continue
        try:
            networks.append(ipaddress.ip_network(entry, strict=False))
        except ValueError:
            continue
    return tuple(networks)


def parse_address(text: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    """The address in a peer or a forwarded hop, without port, brackets or zone; IPv4 in IPv6 dress unwrapped."""
    text = text.strip()
    candidates = [text]
    if text.startswith("[") and "]" in text:
        candidates.insert(0, text[1 : text.index("]")])
    elif text.count(":") == 1:
        candidates.insert(0, text.split(":")[0])
    for candidate in candidates:
        try:
            address = ipaddress.ip_address(candidate.split("%")[0])
        except ValueError:
            continue
        if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
            return address.ipv4_mapped
        return address
    return None


def normal_address(text: str) -> str:
    """One sender, one spelling, for the brake: IPv6 as its /64 (one connection usually holds a whole /64). Before,
    every port and every way of writing an address counted as a new sender."""
    address = parse_address(text)
    if address is None:
        return text.strip()[:64]
    if isinstance(address, ipaddress.IPv6Address) and not address.is_loopback:
        return str(ipaddress.ip_network(f"{address}/64", strict=False))
    return str(address)


def _is_trusted_proxy(text: str) -> bool:
    networks = _trusted_networks(get_settings().trusted_proxies)
    address = parse_address(text) if networks else None
    return address is not None and any(address in network for network in networks)


def is_trusted_proxy(text: str) -> bool:
    """The address belongs to a reverse proxy configured in ``NEXNOTES_TRUSTED_PROXIES``."""
    return _is_trusted_proxy(text)


_warned_unknown_proxy = False
#: Headers a reverse proxy adds; any of them without a trusted proxy configured means one stands in front unnamed.
PROXY_HEADERS = ("x-forwarded-for", "x-real-ip", "forwarded")


def behind_unknown_proxy(request: Request) -> bool:
    """A request that came through a proxy nexnotes was not told to believe: all senders look alike then. Noted once
    in the log, and remembered for the hint under Settings, Server (``unknown_proxy_seen``)."""
    global _warned_unknown_proxy
    if _trusted_networks(get_settings().trusted_proxies) or not any(request.headers.get(h) for h in PROXY_HEADERS):
        return False
    if not _warned_unknown_proxy:
        _warned_unknown_proxy = True
        logger.warning("Requests arrive with proxy headers, but NEXNOTES_TRUSTED_PROXIES is not set: every sender "
                       "looks like the proxy. Set it to the proxy's address so the sign-in brake can tell them apart.")
    return True


def unknown_proxy_seen(request: Request) -> bool:
    """Whether this request or one before came through a proxy that is not configured (while none is)."""
    return behind_unknown_proxy(request) or (
        _warned_unknown_proxy and not _trusted_networks(get_settings().trusted_proxies))


def client_ip(request: Request) -> str:
    """The sender's address, for the brake. ``X-Forwarded-For`` counts only from a configured trusted proxy, and
    then its rightmost hop that is not itself a trusted proxy: everything left of it the sender wrote itself."""
    peer = request.client.host if request.client else "-"
    forwarded = request.headers.get("x-forwarded-for", "")
    if not forwarded or not _is_trusted_proxy(peer):
        return normal_address(peer)
    hops = [hop.strip() for hop in forwarded.split(",") if hop.strip()]
    for hop in reversed(hops):
        if not _is_trusted_proxy(hop):
            return normal_address(hop)
    return normal_address(hops[0] if hops else peer)


#: What an account that must set up its second factor may still reach: itself, the way out, and the setup.
SETUP_ONLY_PATHS = {
    "/api/auth/me", "/api/auth/logout", "/api/auth/totp/begin", "/api/auth/totp/setup", "/api/auth/totp/confirm",
}
#: And its API keys (module schluessel, Bauplan E33): it may list and make them, they rest until the second factor is
#: there ("Wirkt erst, wenn du einen zweiten Faktor einrichtest."; ``KeyStore.keys_wait``, refused on use).
SETUP_ONLY_PREFIXES = ("/api/connections/keys",)


#: What a paired device's token never reaches (NOTES-24): tokens and connected programs, the second factor, the
#: sign-in providers, the password, a connection's key, and everything of the operator. A lost or stolen device must
#: not leave anything behind that outlives disconnecting it, nor take the account. Its name and picture it may change.
DEVICE_REFUSED_PREFIXES = ("/api/tokens", "/api/admin/", "/api/oauth/", "/api/auth/totp", "/api/oidc/",
                           "/api/connections", "/api/connect/")
DEVICE_REFUSED = frozenset({("PUT", "/api/auth/password"), ("PUT", "/api/nextasks"), ("DELETE", "/api/nextasks")})


def device_refused(request: Request) -> bool:
    path = request.url.path
    return path.startswith(DEVICE_REFUSED_PREFIXES) or (request.method, path) in DEVICE_REFUSED


def browser_only() -> HTTPException:
    return error("browser_only", "Only in the browser.", 403)


def _bearer(request: Request) -> str:
    header = request.headers.get("authorization", "")
    return header[7:].strip() if header[:7].lower() == "bearer " else ""


def _device_refusal(db: Session, token: str) -> str:
    """``device_disconnected`` or ``account_blocked`` for a device's token that opens nothing (``devices``)."""
    from .services import devices

    try:
        devices.authenticate(db, token)
    except devices.Refusal as refusal:
        return refusal.code if refusal.code != "second_factor_required" else "device_disconnected"
    return "device_disconnected"


def require_account(request: Request) -> AccountRow:
    """The signed-in account, detached from the database session (routes open their own). A browser brings its
    session cookie; a paired device or a program its token (``Authorization: Bearer``).

    A blocked or deleted account is out at once on every device: an open window hears ``account_blocked`` (and shows
    "Your account is blocked"), a token answers like none."""
    with SessionLocal() as db:
        token = _bearer(request)
        if token:
            # MCP keys only at /api/mcp (routers/mcp.py): here a paired device's token.
            found = apitokens.authenticate(db, token, (TOKEN_DEVICE,))
            if found is None:
                if token.startswith(apitokens.PREFIXES[TOKEN_DEVICE]):
                    # A paired device hears why, as under ``/api/app/1`` (NOTES-24 EC-1, EC-5): disconnected, or its
                    # account blocked or deleted.
                    raise error(_device_refusal(db, token), "This device was disconnected or its account blocked.",
                                401)
                raise error("sign_in_required", "Sign in first.", 401)
            account = found[0]
            if device_refused(request):
                raise browser_only()
            if totp.setup_required(db, account):
                # The operator requires a second factor this account has not set up: the app signs in anew.
                raise error("second_factor_required", "Set up your second factor in the browser first.", 401)
            db.expunge(account)
            logs.set_actor(account.name)
            return account
        cookie = request.cookies.get(SESSION_COOKIE)
        account = session_account(db, cookie)
        if account is None:
            owner = session_owner(db, cookie)
            if owner is not None and account_out(owner):
                raise error("account_blocked", "This account is blocked. Ask the operator to unblock it.", 401)
            raise error("sign_in_required", "Sign in first.", 401)
        path = request.url.path
        open_while_setup = path in SETUP_ONLY_PATHS or path.startswith(SETUP_ONLY_PREFIXES)
        if not open_while_setup and totp.setup_required(db, account):
            raise error("second_factor_setup_required", "Set up your second factor first.", 403)
        db.expunge(account)
    logs.set_actor(account.name)
    return account


def require_operator(request: Request, account: Annotated[AccountRow, Depends(require_account)]) -> AccountRow:
    if _bearer(request):
        # The operator's settings only from a browser, never with a paired device's token.
        raise browser_only()
    if account.role != OPERATOR:
        raise error("operator_only", "Only the operator may do this.", 403)
    networks = _trusted_networks(get_settings().operator_networks)
    if networks:
        try:
            sender = ipaddress.ip_address(client_ip(request).split("/")[0])
        except ValueError:
            sender = None
        # An IPv6 sender stands as its /64 here: its network's first address is inside the operator's networks
        # exactly when the /64 is (they are not smaller than /64 in a home network).
        if sender is None or not any(sender in network for network in networks):
            raise error("operator_network", "The operator's settings are open only from the home network.", 403)
    return account


Account = Annotated[AccountRow, Depends(require_account)]
OperatorAccount = Annotated[AccountRow, Depends(require_operator)]


# --- The password once more, while signed in ------------------------------------------------------------------------
#
# Changing the password or linking the account to a provider asks for the password again, and a wrong answer counts
# the way it does at sign-in: otherwise a stolen cookie would be a place to guess without limit. Since konten 0.3.4
# the count is the shared module's (``confirm:<account>``, five free), the same the module's own doors use: a route
# of nexnotes' own and one of the module never count apart.


def _reauth_keys(account: AccountRow) -> tuple[str, ...]:
    return (door_key(DOOR_CONFIRM, account.id),)


def reauth_guard(request: Request, account: AccountRow) -> None:
    """One password typed to confirm: refused while the account is locked or its count waits; counted as a failure
    until ``reauth_succeeded`` takes it back."""
    if accounts.is_locked(account):
        raise error("account_locked", "Too many failed attempts. Try again later.", 429)
    wait = BRAKE.claim(_reauth_keys(account))
    if wait > 0:
        seconds = max(1, int(wait + 0.999))
        raise HTTPException(
            status_code=429,
            detail=detail("too_many_attempts", "Too many attempts. Try again later.", retry_after=seconds),
            headers={"Retry-After": str(seconds)},
        )


def reauth_failed(request: Request, db: Session, account: AccountRow) -> None:
    accounts.note_failure(db, account)


def reauth_succeeded(request: Request, db: Session, account: AccountRow) -> None:
    BRAKE.succeeded(_reauth_keys(account))
    accounts.note_success(db, account)


#: How old the session of an account that signs in through a provider may be for an operator act or another act a
#: stolen session must not be enough for (a new vault, NOTES-16 EC-2).
#: The shared module's window (``nexkonten.common.FRESH_SIGN_IN_MINUTES``, five minutes since 0.3.2).
OPERATOR_FRESH_MINUTES = FRESH_SIGN_IN_MINUTES


def _fresh_from_provider(request: Request, db: Session, row: AccountRow) -> None:
    """An operator without a password here proves it is still them by a sign-in at the provider younger than
    ``OPERATOR_FRESH_MINUTES``: the browser session must be that new. Otherwise the refusal names the operator's
    providers, and the page sends the browser there with ``fresh=1`` (``prompt=login``, ``max_age=0``) and back.
    A token (a paired device, an MCP key) is never enough."""
    cookie = request.cookies.get(SESSION_COOKIE)
    session = None
    if cookie and not _bearer(request):
        session = db.scalar(select(AuthSession).where(AuthSession.token_hash == hash_token(cookie)))
    if session is not None and session.account_id == row.id and fresh_sign_in(session.created_at, utcnow()):
        return
    providers = [
        {"slug": entry.slug, "label": entry.label}
        for entry in db.scalars(
            select(OidcProvider)
            .join(OidcLink, OidcLink.provider_id == OidcProvider.id)
            .where(OidcLink.account_id == row.id, OidcProvider.enabled.is_(True))
            .order_by(OidcProvider.position, OidcProvider.id)
        )
    ]
    raise error("fresh_sign_in_required", "Sign in at your provider again first: this needs a sign-in from the "
                f"last {OPERATOR_FRESH_MINUTES} minutes.", 403, minutes=OPERATOR_FRESH_MINUTES, providers=providers)


def confirm_fresh_session(request: Request, db: Session, account: AccountRow) -> None:
    """The browser session is younger than ``OPERATOR_FRESH_MINUTES``: the person signed in just now (after a new
    password through a link, "Disconnect all" asks no password again, but a stolen older session is not enough)."""
    cookie = request.cookies.get(SESSION_COOKIE)
    session = None
    if cookie and not _bearer(request):
        session = db.scalar(select(AuthSession).where(AuthSession.token_hash == hash_token(cookie)))
    if session is not None and session.account_id == account.id and fresh_sign_in(session.created_at, utcnow()):
        return
    raise error("fresh_sign_in_required", "Sign in again first: this needs a sign-in from the last "
                f"{OPERATOR_FRESH_MINUTES} minutes.", 403, minutes=OPERATOR_FRESH_MINUTES, providers=[])


def confirm_operator(request: Request, db: Session, operator: AccountRow, password: str) -> None:
    """The operator's password once more, before an act a stolen session must not be enough for: carrying a backup
    away or bringing one back, making a reset link for another account, taking its second factor, changing a role,
    blocking or deleting an account. An operator who signs in through a provider has no password here; it needs a
    sign-in at the provider from the last few minutes instead (``_fresh_from_provider``)."""
    row = db.get(AccountRow, operator.id)
    assert row is not None
    if row.sign_in != SIGN_IN_PASSWORD:
        _fresh_from_provider(request, db, row)
        return
    reauth_guard(request, row)
    if not accounts.check_password(row, password):
        reauth_failed(request, db, row)
        raise error("wrong_password", "The current password is wrong.", 401)
    reauth_succeeded(request, db, row)


def _second_factor_ok(row: AccountRow, code: str) -> bool:
    """A code of the account's second factor, or one of its recovery codes (used up), as at sign-in."""
    typed = totp.normalize_code(code or "")
    if len(typed) == totp.DIGITS and typed.isdigit():
        try:
            seed = totp.open_seed(row.totp_secret_enc)
        except totp.SeedUnreadable:
            return False
        step = totp.verify_code(seed, typed, after_step=row.totp_last_step)
        if step is None:
            return False
        row.totp_last_step = step
        return True
    remaining = totp.use_recovery(row.totp_recovery, typed) if typed else None
    if remaining is None:
        return False
    row.totp_recovery = remaining
    return True


def confirm_fresh(request: Request, db: Session, account: AccountRow, password: str, code: str) -> None:
    """The member proves once more that it is them, before an act that destroys what a stolen session must not be
    able to destroy (a new vault takes every locked note, NOTES-16 EC-2): the account's password and, when it has
    one, a code of its second factor; an account that signs in through a provider needs a sign-in there from the last
    ``OPERATOR_FRESH_MINUTES`` (``prompt=login``). Wrong answers count like those at sign-in."""
    row = db.get(AccountRow, account.id)
    assert row is not None
    if row.sign_in != SIGN_IN_PASSWORD:
        _fresh_from_provider(request, db, row)
        return
    reauth_guard(request, row)
    if not accounts.check_password(row, password):
        reauth_failed(request, db, row)
        raise error("wrong_password", "The current password is wrong.", 401)
    if row.totp_secret_enc and not _second_factor_ok(row, code):
        reauth_failed(request, db, row)
        raise error("totp_code_wrong", "The code is not right.", 401, field="code")
    reauth_succeeded(request, db, row)
    db.commit()

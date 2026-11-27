"""nexnotes' side of the shared module verbinden (``vendor/nexverbinden`` 0.1.1, plan "Entwurf Apps verbinden"): its
``AppConfig`` and the ``Store`` over the tables of ``models_verbinden``.

nexnotes is a guest at nextasks (tasks to read and write, NOTES-19) and at the other notes app of the catalog (notes
to add), and the host of nextime (it adds notes into the folders it was given). What a connection opens here is
``POST /api/v1/notes`` into the folders given, nothing else (``routers/api_v1.wall``).

⚠️ **Old connections.** The connection to nextasks typed in by hand (``nextasks_connections``, ``PUT /api/nextasks``,
also from the iPhone app) keeps working; the module reads it to show it ("Verbunden über API-Schlüssel ntk_…"). Since
verbinden 0.2.0 (B9, V56) it ends once the account connects with a click, disconnects or declines (``forget_legacy``:
the sealed key goes, the choice of lists stays); the key typed in back then ends itself at nextasks (``old_key``) and
nexnotes uses the new connection (``services/nextasks.connected_access``).
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any
from urllib.parse import quote

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from .. import __version__
from ..models import TOKEN_API, Account, ApiToken, Setting
from ..models_nextasks import NextasksConnection
from ..models_verbinden import (
    AppConnection,
    AppConnectionCode,
    AppConnectionPending,
    AppConnectionSpent,
    AppConnectionWaiting,
)
from ..security import account_out, decrypt_secret, encrypt_secret
from ..vendor import nexverbinden
from . import apitokens, settings_service, totp

logger = logging.getLogger("nexnotes.connect")

#: nexnotes' tokens for its partners: never the start of one of its API keys (``nn_api_``, ``nn_mcp_``, ``nnd_``).
#: Partners in use (V20): nextasks (tasks, NOTES-19), nexlore (a note into it), nextime (adds notes here).
CONFIG = nexverbinden.AppConfig(app_name="nexnotes", version=__version__, access_prefix="nnx_",
                                refresh_prefix="nnxr_", code_prefix="nnxc_", in_use=("nextasks", "nexlore", "nextime"))
#: The module's settings under nexnotes' names (``connect.connections``, ``connect.addresses``).
SETTING_PREFIX = "connect."
#: How the sealing of the module's secrets is told apart from nexnotes' other sealed texts.
SEAL_CONTEXT = "verbinden"


def _aware(moment: datetime | None) -> datetime | None:
    if moment is None:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)


def _list(value: Any) -> list[Any] | None:
    return list(value) if value is not None else None


class VerbindenStore:
    """``nexverbinden.Store`` inside one session (one request)."""

    def __init__(self, db: Session) -> None:
        self.db = db

    # --- connections ------------------------------------------------------------------------------------------------

    @staticmethod
    def _connection(row: AppConnection | None) -> nexverbinden.Connection | None:
        if row is None:
            return None
        return nexverbinden.Connection(
            id=row.id, account_id=row.account_id, partner=row.partner, partner_base=row.partner_base,
            partner_account=row.partner_account, uses=tuple(row.uses or ()), grants=tuple(row.grants or ()),
            areas_granted=_list(row.areas_granted), areas_used=_list(row.areas_used), held=row.held,
            issued_access_hash=row.issued_access_hash, issued_refresh_hash=row.issued_refresh_hash,
            issued_access_expires=_aware(row.issued_access_expires) or datetime.now(UTC),
            created_at=_aware(row.created_at) or datetime.now(UTC), used_at=_aware(row.used_at),
            ok_at=_aware(row.ok_at), state=row.state, stale_since=_aware(row.stale_since), problem=row.problem,
            partner_version=row.partner_version or "",
        )

    def connections(self, account_id: Any) -> list[nexverbinden.Connection]:
        rows = self.db.scalars(select(AppConnection).where(AppConnection.account_id == int(account_id))
                               .order_by(AppConnection.partner))
        return [found for row in rows if (found := self._connection(row)) is not None]

    def connection(self, account_id: Any, partner: str) -> nexverbinden.Connection | None:
        return self._connection(self.db.scalar(select(AppConnection).where(
            AppConnection.account_id == int(account_id), AppConnection.partner == partner)))

    def by_issued_access(self, token_hash: str) -> nexverbinden.Connection | None:
        return self._connection(self.db.scalar(select(AppConnection)
                                               .where(AppConnection.issued_access_hash == token_hash)))

    def by_issued_refresh(self, token_hash: str) -> nexverbinden.Connection | None:
        return self._connection(self.db.scalar(select(AppConnection)
                                               .where(AppConnection.issued_refresh_hash == token_hash)))

    def save(self, c: nexverbinden.Connection) -> None:
        row = self.db.get(AppConnection, c.id)
        if row is None:
            # One connection per account and partner: a new one takes the place of one of before.
            self.db.execute(delete(AppConnection).where(AppConnection.account_id == int(c.account_id),
                                                        AppConnection.partner == c.partner))
            row = AppConnection(id=c.id)
            self.db.add(row)
        row.account_id = int(c.account_id)
        row.partner, row.partner_base, row.partner_account = c.partner, c.partner_base, c.partner_account
        row.uses, row.grants = list(c.uses), list(c.grants)
        row.areas_granted, row.areas_used = c.areas_granted, c.areas_used
        row.held = c.held
        row.issued_access_hash, row.issued_refresh_hash = c.issued_access_hash, c.issued_refresh_hash
        row.issued_access_expires, row.created_at = c.issued_access_expires, c.created_at
        row.used_at, row.ok_at, row.state, row.stale_since = c.used_at, c.ok_at, c.state, c.stale_since
        row.problem, row.partner_version = c.problem, c.partner_version
        self.db.flush()

    def remove(self, connection_id: str) -> None:
        self.db.execute(delete(AppConnection).where(AppConnection.id == connection_id))
        self.db.execute(delete(AppConnectionSpent).where(AppConnectionSpent.connection_id == connection_id))

    # --- started connections and codes -----------------------------------------------------------------------------

    def add_pending(self, p: nexverbinden.Pending) -> None:
        self.db.add(AppConnectionPending(state_hash=p.state_hash, account_id=int(p.account_id), partner=p.partner,
                                         partner_base=p.partner_base, verifier=p.verifier,
                                         areas_granted=p.areas_granted, created_at=p.created_at))
        self.db.flush()

    def take_pending(self, state_hash: str) -> nexverbinden.Pending | None:
        row = self.db.get(AppConnectionPending, state_hash)
        if row is None:
            return None
        found = nexverbinden.Pending(state_hash=row.state_hash, account_id=row.account_id, partner=row.partner,
                                     partner_base=row.partner_base, verifier=row.verifier,
                                     areas_granted=_list(row.areas_granted),
                                     created_at=_aware(row.created_at) or datetime.now(UTC))
        self.db.delete(row)
        self.db.flush()
        return found

    def add_code(self, c: nexverbinden.Code) -> None:
        self.db.add(AppConnectionCode(code_hash=c.code_hash, account_id=int(c.account_id), partner=c.partner,
                                      partner_base=c.partner_base, redirect_uri=c.redirect_uri,
                                      challenge=c.challenge, areas_granted=c.areas_granted, expires_at=c.expires_at))
        self.db.flush()

    def take_code(self, code_hash: str) -> nexverbinden.Code | None:
        row = self.db.get(AppConnectionCode, code_hash)
        if row is None:
            return None
        found = nexverbinden.Code(code_hash=row.code_hash, account_id=row.account_id, partner=row.partner,
                                  partner_base=row.partner_base, redirect_uri=row.redirect_uri,
                                  challenge=row.challenge, areas_granted=_list(row.areas_granted),
                                  expires_at=_aware(row.expires_at) or datetime.now(UTC))
        self.db.delete(row)
        self.db.flush()
        return found

    # --- spent ------------------------------------------------------------------------------------------------------

    def spend(self, connection_id: str, token_hash: str, keep: int) -> None:
        at = int(self.db.scalar(select(func.coalesce(func.max(AppConnectionSpent.at), 0))) or 0) + 1
        self.db.merge(AppConnectionSpent(token_hash=token_hash, connection_id=connection_id, at=at))
        self.db.flush()
        kept = (select(AppConnectionSpent.at).where(AppConnectionSpent.connection_id == connection_id)
                .order_by(AppConnectionSpent.at.desc()).limit(keep))
        self.db.execute(delete(AppConnectionSpent).where(AppConnectionSpent.connection_id == connection_id,
                                                         AppConnectionSpent.at.not_in(kept)))

    def spent_by(self, token_hash: str) -> str | None:
        row = self.db.get(AppConnectionSpent, token_hash)
        return row.connection_id if row is not None else None

    # --- revocations that wait ----------------------------------------------------------------------------------------

    def revoke_later(self, account_id: Any, partner_base: str, sealed_token: str, now: datetime) -> None:
        self.db.add(AppConnectionWaiting(account_id=int(account_id), partner_base=partner_base, token=sealed_token,
                                         since=now))
        self.db.flush()

    def waiting(self) -> list[nexverbinden.Waiting]:
        rows = self.db.scalars(select(AppConnectionWaiting).order_by(AppConnectionWaiting.id))
        return [nexverbinden.Waiting(row.id, row.partner_base, row.token, _aware(row.since) or datetime.now(UTC))
                for row in rows]

    def done_waiting(self, waiting_id: Any) -> None:
        self.db.execute(delete(AppConnectionWaiting).where(AppConnectionWaiting.id == int(waiting_id)))

    # --- the account and the app 

    def account_may(self, account_id: Any) -> bool:
        """Blocked, deleted, or owing the second factor the operator requires (EC-9, as API and MCP keys): the
        account's connections rest."""
        account = self.db.get(Account, int(account_id))
        return account is not None and not account_out(account) and not totp.setup_required(self.db, account)

    def account_name(self, account_id: Any) -> str:
        """The account's user name, as the other app names it ("verbunden als kim"); the shown name with the picture
        goes to the consent page through ``account_card`` (verbinden 0.1.8, V43). Up to 0.1.7 the shown name stood
        here: the contract now reads this as the user name of the card."""
        account = self.db.get(Account, int(account_id))
        return account.name if account is not None else ""

    def account_card(self, account_id: Any) -> dict[str, Any] | None:
        """The account on the consent page (verbinden 0.1.8, V43): the shown name, the user name, and the own profile
        picture at the address the sidebar asks for (``lib/avatar.ts``, the time it was set as its version). nexnotes
        has no colour of a person (the colours of the others in a note are given per note)."""
        account = self.db.get(Account, int(account_id))
        if account is None:
            return None
        stamp = account.avatar_at.isoformat() if account.avatar_at else None
        picture = f"/api/avatars/{account.id}?v={quote(stamp, safe='')}" if stamp else None
        return {"name": account.display_name, "username": account.name, "picture": picture, "color": None}

    def areas(self, account_id: Any) -> list[dict[str, Any]]:
        """The account's folders (the inbox first, paths in the names), as a key may be limited to them."""
        from .schluessel_store import KeyStore

        return [{"id": area.id, "name": area.name} for area in KeyStore(self.db).areas_of(account_id, "api")]

    def legacy(self, account_id: Any) -> list[nexverbinden.Legacy]:
        """The connection to nextasks typed in by hand (NOTES-19), as it stands; its key shown by its start only."""
        row = self.db.get(NextasksConnection, int(account_id))
        if row is None or not row.token_enc:
            # None, or only the choice of lists kept for a connection made with a click.
            return []
        token = decrypt_secret(row.token_enc, f"nextasks:{row.account_id}")
        return [nexverbinden.Legacy(partner="nextasks", partner_base=row.url, shown=token[:8],
                                    ok_at=_aware(row.checked_at))]

    def forget_legacy(self, account_id: Any, partner: str) -> None:
        """verbinden 0.2.0 (B9, V56): the connection to nextasks typed in by hand ends (a click connection, "Trennen" or
        "Ablehnen" with nextasks); the row stays with the choice of lists a click connection keeps in it. A row a paired
        device made (``device_id``, NOTESIOS-22) ends too: the click connection counts for the account."""
        if partner != "nextasks":
            return
        row = self.db.get(NextasksConnection, int(account_id))
        if row is None or not row.token_enc:
            return
        row.token_enc = ""
        row.device_id = None
        self.db.flush()

    def retire_key(self, token: str) -> bool:
        """An API token of nexnotes that a partner had typed in ends itself (after the partner connected anew)."""
        row = self.db.scalar(select(ApiToken).where(ApiToken.token_hash == apitokens.digest(token),
                                                    ApiToken.kind == TOKEN_API))
        if row is None:
            return False
        logger.info("An API token ended itself after a new connection token_id=%s", row.id)
        self.db.delete(row)
        self.db.flush()
        return True

    def setting(self, name: str) -> Any:
        row = self.db.get(Setting, SETTING_PREFIX + name)
        return None if row is None else row.value

    def set_setting(self, name: str, value: Any) -> None:
        row = self.db.get(Setting, SETTING_PREFIX + name)
        if row is None:
            self.db.add(Setting(key=SETTING_PREFIX + name, value=value))
        else:
            row.value = value
        self.db.flush()

    def local_allowed(self) -> bool:
        return bool(settings_service.get(self.db, "connections_local_network"))

    def set_local_allowed(self, on: bool) -> None:
        """The tick in the card "Andere nex-Apps" (verbinden 0.1.4): the same setting as nexnotes' own under Server ›
        Allgemein (``PUT /api/settings``), so both show one value."""
        settings_service.save(self.db, {"connections_local_network": bool(on)}, commit=False)

    def seal(self, text: str) -> str:
        return encrypt_secret(text, SEAL_CONTEXT)

    def unseal(self, sealed: str) -> str:
        return decrypt_secret(sealed, SEAL_CONTEXT)

    def commit(self) -> None:
        self.db.commit()

    def rollback(self) -> None:
        self.db.rollback()


def disconnected(store: VerbindenStore, account_id: Any, partner: str) -> None:
    """A connection made here ended, by "Trennen" or by the partner (verbinden 0.1.4, ``on_disconnected``): the row
    without a key that kept the account's choice of nextasks' areas and lists for it goes too, as "Trennen" of a key
    typed in drops its row (``nextasks.disconnect``). A row with a key is the older connection and stays."""
    if partner != "nextasks":
        return
    from ..models_nextasks import NextasksConnection

    row = store.db.get(NextasksConnection, int(account_id))
    if row is not None and not row.token_enc:
        store.db.delete(row)
        store.db.commit()
        logger.info("nextasks choice of a connection by click dropped account_id=%s", account_id)

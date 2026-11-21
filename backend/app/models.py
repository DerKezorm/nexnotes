"""The data model.

Everything lives in SQLite. This frame holds accounts, sessions, sign-in providers, invitations, tokens of programs
and devices, and the operator's settings. Notes, folders and their history come with their own tables (see
``services/content.py`` for where they report back to the accounts).
"""

from __future__ import annotations

import secrets
from datetime import UTC, datetime
from typing import Any, ClassVar

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
    event,
    false,
    text,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy.types import TypeDecorator


def utcnow() -> datetime:
    return datetime.now(UTC)


class UtcDateTime(TypeDecorator[datetime]):
    """SQLite forgets the time zone. Stored as UTC, read back as UTC with the zone attached."""

    impl = DateTime
    cache_ok = True

    def process_bind_param(self, value: datetime | None, dialect: Any) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None:
            raise ValueError("naive datetime")
        return value.astimezone(UTC).replace(tzinfo=None)

    def process_result_value(self, value: datetime | None, dialect: Any) -> datetime | None:
        return None if value is None else value.replace(tzinfo=UTC)


class Base(DeclarativeBase):
    pass


class Setting(Base):
    __tablename__ = "settings"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[Any] = mapped_column(JSON, nullable=True)


OPERATOR = "operator"
MEMBER = "member"
ROLES = (OPERATOR, MEMBER)

SIGN_IN_PASSWORD = "password"
SIGN_IN_OIDC = "oidc"

#: How long a deleted account can be brought back by the operator before it goes for good.
DELETE_GRACE_DAYS = 30



class Account(Base):
    """A person. The first account is the operator; the others come by invitation or through OIDC."""

    __tablename__ = "accounts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    #: Lower case, unique; made from the address or the name. People sign in with their address or this name.
    name: Mapped[str] = mapped_column(String(64), unique=True)
    #: What people see: the name as typed (umlauts and emoji kept, blanks at the edges gone).
    display_name: Mapped[str] = mapped_column(String(80), default="")
    #: The version whose "What's new" the account has read or put away.
    whats_new_seen: Mapped[str] = mapped_column(String(32), default="")
    role: Mapped[str] = mapped_column(String(16), default=MEMBER)
    sign_in: Mapped[str] = mapped_column(String(16), default=SIGN_IN_PASSWORD)
    #: Argon2id. Empty for accounts that sign in through OIDC only.
    password_hash: Mapped[str] = mapped_column(String(255), default="")
    password_changed_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    #: Unique ignoring case; empty for an account without one.
    email: Mapped[str] = mapped_column(String(255), default="")
    #: Where ``email`` came from: "" (typed or an invitation) or ``provider`` (a sign-in provider's address). An
    #: address from a provider goes with the account's last link (the shared sign-in module).
    email_source: Mapped[str] = mapped_column(String(16), default="", server_default="")
    #: The address a provider knows the account by, offered on the account page to an account with a password (it
    #: takes it only when it says so); ``provider_email_off``: the address the account said "don't ask again" to.
    provider_email: Mapped[str] = mapped_column(String(255), default="", server_default="")
    provider_email_off: Mapped[str] = mapped_column(String(255), default="", server_default="")
    #: The interface language chosen under "My account"; empty: the browser's. Travels to every device.
    language: Mapped[str] = mapped_column(String(16), default="")
    #: The browser's language at the last sign-in: what a mail to the account is written in while ``language`` is
    #: empty.
    browser_language: Mapped[str] = mapped_column(String(16), default="")
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    last_seen_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    failed_logins: Mapped[int] = mapped_column(Integer, default=0)
    locked_until: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    #: Set when the operator blocked the account: no sign-in, sessions and device tokens end at once.
    blocked_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    #: Set when the operator deleted the account. It counts as blocked and as gone for everybody else; for 30 days the
    #: operator can bring it back, then it goes with everything it owns.
    deleted_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    #: The password was set through a reset link of the operator: the account hears so at its next sign-in, until it
    #: puts the notice away (NOTES-2 AC-7, the operator never signs in as somebody else unnoticed).
    password_reset_notice: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false())
    #: The most this account may keep, in bytes; None: no limit.
    storage_limit: Mapped[int | None] = mapped_column(Integer, nullable=True)
    #: The second factor (``services/totp.py``): the seed encrypted with the server secret, empty while off; the
    #: recovery codes as a JSON list of SHA-256 hashes; the time step of the last code taken (no replay).
    totp_secret_enc: Mapped[str] = mapped_column(Text, default="")
    totp_recovery: Mapped[str] = mapped_column(Text, default="")
    totp_last_step: Mapped[int] = mapped_column(Integer, default=0)
    #: The profile picture (``services/avatars.py``): a square WebP drawn anew, loaded only when asked for.
    avatar: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True, deferred=True)
    avatar_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    #: The account's own preferences; only what it chose.
    preferences: Mapped[Any] = mapped_column(JSON, nullable=True)
    #: What the device cookies of this account are signed with (``security.device_token``): drawn anew on a new
    #: password, a block or unblock, "sign out everywhere" and a reset second factor, so no browser from before counts
    #: as known any more.
    device_key: Mapped[str] = mapped_column(String(64), default="")
    #: Not stored. True on the account of a session that came through a provider which checks the second factor.
    provider_checked: ClassVar[bool] = False

    @property
    def shown_name(self) -> str:
        return self.display_name or self.name


def new_device_key() -> str:
    return secrets.token_urlsafe(24)


@event.listens_for(Account, "before_insert")
def _first_device_key(_mapper: Any, _connection: Any, target: Account) -> None:
    if not target.device_key:
        target.device_key = new_device_key()


@event.listens_for(Account.password_hash, "set")
@event.listens_for(Account.blocked_at, "set")
@event.listens_for(Account.deleted_at, "set")
def _forget_devices(target: Account, value: Any, old: Any, _initiator: Any) -> None:
    """A new password, a block or an unblock: the browsers known before are not known any more, whatever the way it
    happens."""
    if value != old:
        target.device_key = new_device_key()


class AuthSession(Base):
    """A browser session. Only the hash of the token is stored; the token itself lives in the cookie."""

    __tablename__ = "auth_sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(UtcDateTime)
    last_seen_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    ip: Mapped[str] = mapped_column(String(64), default="")
    user_agent: Mapped[str] = mapped_column(String(255), default="")
    #: This sign-in came through a provider that checks the second factor itself (the entry's switch was on): the
    #: operator's "second factor required" does not force a setup for this session, whatever the account is.
    provider_checked: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false())


class OidcProvider(Base):
    """A sign-in provider (OpenID Connect), one row each; the columns as the shared sign-in blueprint names them. Read
    and written only through ``services/oidc_store.py`` for the shared module ``vendor/nexoidc``."""

    __tablename__ = "oidc_providers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    #: Part of the callback address ``/api/oidc/<slug>/callback``; fixed once made.
    slug: Mapped[str] = mapped_column(String(40), unique=True)
    #: The name on the sign-in button.
    label: Mapped[str] = mapped_column(String(64))
    #: Stored without blanks and without a slash at the end.
    issuer: Mapped[str] = mapped_column(String(500))
    client_id: Mapped[str] = mapped_column(String(255))
    #: Encrypted with the server secret under the context ``oidc-provider:<id>``; empty for a public client.
    client_secret_enc: Mapped[str] = mapped_column(Text, default="")
    scopes: Mapped[str] = mapped_column(String(500), default="openid profile email")
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    #: "New people get an account": off from the start.
    auto_create: Mapped[bool] = mapped_column(Boolean, default=False)
    #: "The provider checks the second factor itself": on from the start.
    trusts_second_factor: Mapped[bool] = mapped_column(Boolean, default=True)
    #: "" by hand, "authentik" made by the authentik button, and the coupled value from the coupling.
    managed: Mapped[str] = mapped_column(String(20), default="")
    position: Mapped[int] = mapped_column(Integer, default=0)
    #: A callback path the provider knew before (a migration or a coupling sets it); "" is the standard one.
    redirect_path: Mapped[str] = mapped_column(String(300), default="")
    #: The redirect address the authentik button registered at authentik the last time ("" for none; an entry of
    #: before 1.0.10 has none). The card reports ``stale`` when today's address is another.
    registered_redirect: Mapped[str] = mapped_column(String(500), default="", server_default="")
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)


class OidcLink(Base):
    """One identity at one provider, bound to one account. Found only by ``(provider_id, subject)``, never by an
    address: ``email`` is for display."""

    __tablename__ = "oidc_links"
    __table_args__ = (
        UniqueConstraint("provider_id", "subject"),
        UniqueConstraint("provider_id", "account_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    provider_id: Mapped[int] = mapped_column(ForeignKey("oidc_providers.id", ondelete="CASCADE"), index=True)
    subject: Mapped[str] = mapped_column(String(255))
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), index=True)
    #: The ``iss`` of the token that made the link (with Entra ``common`` the real tenant).
    issuer: Mapped[str] = mapped_column(String(500))
    email: Mapped[str | None] = mapped_column(String(320), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    last_used_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)




class Invite(Base):
    """A link that lets somebody in as a new account. Only the hash of the token is stored; used once, then gone."""

    __tablename__ = "invites"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    #: The role the new account gets.
    role: Mapped[str] = mapped_column(String(16), default=MEMBER)
    email: Mapped[str] = mapped_column(String(255), default="")
    created_by: Mapped[int | None] = mapped_column(ForeignKey("accounts.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(UtcDateTime)


class PasswordReset(Base):
    """A link the operator makes for an account that forgot its password: the person sets a new one themselves, the
    operator never knows it. Only the hash of the token is stored; used once, then gone; one per account."""

    __tablename__ = "password_resets"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), index=True)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("accounts.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(UtcDateTime)


#: Token kinds: a paired iPhone or iPad (NOTES-24), or a key for MCP tools (NOTES-20). Both act as their account.
TOKEN_DEVICE = "device"
TOKEN_MCP = "mcp"
#: A key nexdeck reads a member's card with (NOTES-21), valid under ``/api/v1/`` only.
TOKEN_DASHBOARD = "dashboard"


class ApiToken(Base):
    """A token a program or a device signs in with (``Authorization: Bearer``). Only the SHA-256 is stored. Made by
    the features that pair devices and hand out MCP keys; the frame checks them, and the tokens of a blocked or
    deleted account count for nothing."""

    __tablename__ = "api_tokens"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(16), default=TOKEN_DEVICE)
    name: Mapped[str] = mapped_column(String(100))
    #: ``read`` or ``write``.
    level: Mapped[str] = mapped_column(String(8), default="write")
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    prefix: Mapped[str] = mapped_column(String(16))
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    last_used_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    #: An MCP key a connector got by signing in with OAuth (NOTES-20 AC-7): its client, the SHA-256 of its refresh
    #: token, and when its account last agreed. Tokens traded in already are rows of ``oauth_spent``;
    #: ``refresh_old_hash`` is no longer written, only read for keys refreshed before that table came.
    client_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    refresh_hash: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    refresh_old_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    signed_in_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)


#: Folder kinds: the account's own inbox (one per account, cannot be deleted, renamed or moved) and normal folders.
FOLDER_INBOX = "inbox"
FOLDER_NORMAL = "normal"


def new_uuid() -> str:
    """Ids of notes and folders are UUIDs, so that the iOS app can make them offline."""
    import uuid

    return str(uuid.uuid4())


class Folder(Base):
    """A folder of one account; folders nest without a limit (``parent_id``). The inbox is a folder of its own kind."""

    __tablename__ = "folders"
    __table_args__ = (
        # One inbox per account, also when two first requests make it at the same moment (``services/inbox.py``).
        Index("uq_folders_one_inbox", "owner_id", unique=True, sqlite_where=text("kind = 'inbox'")),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    owner_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), index=True)
    parent_id: Mapped[str | None] = mapped_column(
        ForeignKey("folders.id", ondelete="CASCADE"), nullable=True, index=True
    )
    kind: Mapped[str] = mapped_column(String(16), default=FOLDER_NORMAL)
    #: At most 60 characters, blanks at the edges gone; unique per parent ignoring case.
    name: Mapped[str] = mapped_column(String(60), default="")
    icon: Mapped[str] = mapped_column(String(32), default="")
    color: Mapped[str] = mapped_column(String(16), default="")
    #: Order among its siblings once the member has dragged them; ``None`` means alphabetical.
    position: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow, onupdate=utcnow)
    #: In the trash since (NOTES-15); ``None`` while alive.
    deleted_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True, index=True)
    #: The mark of the deletion that took it (NOTES-4 AC-5): a folder goes with its subfolders and notes under one
    #: mark, and bringing it back brings back exactly what carries the mark.
    deleted_batch: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)


class Note(Base):
    """A note. Its text is a Yjs document in the format nexnotes-doc 1 (``app/notedoc``): ``ydoc`` holds it folded,
    ``note_updates`` what came since. ``title`` and ``text`` are copies for lists, search and preview."""

    __tablename__ = "notes"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    owner_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), index=True)
    folder_id: Mapped[str] = mapped_column(ForeignKey("folders.id", ondelete="CASCADE"), index=True)
    #: At most 120 characters; empty only while the note is being written.
    title: Mapped[str] = mapped_column(String(120), default="")
    #: The title was suggested, not typed ("Titel prüfen", NOTES-3 AC-10) until changed once or confirmed.
    title_check: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false())
    #: Where a quickly captured note came from (NOTES-4 AC-7), e.g. "share:Safari", "dictation", "mcp:<client>".
    origin: Mapped[str] = mapped_column(String(100), default="")
    ydoc: Mapped[bytes] = mapped_column(LargeBinary, default=b"")
    #: Plain text of the body, for search and preview.
    text: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow, index=True)
    updated_by_id: Mapped[int | None] = mapped_column(
        ForeignKey("accounts.id", ondelete="SET NULL"), nullable=True
    )
    #: In the trash since (NOTES-15); ``None`` while alive.
    deleted_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True, index=True)
    #: Went to the trash with its folder (NOTES-4 AC-5): the mark of that deletion, ``None`` for a note deleted alone.
    deleted_batch: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    #: Who put it in the trash, when that was somebody it was shared with (NOTES-13 AC-8, NOTES-15 AC-6); ``None``
    #: for the owner itself.
    deleted_by_id: Mapped[int | None] = mapped_column(
        ForeignKey("accounts.id", ondelete="SET NULL"), nullable=True
    )
    #: Pinned since (NOTES-6 AC-6); ``None`` when not. Kept through the trash: a note comes back pinned (EC-8).
    pinned_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    #: The note's color (NOTES-6 AC-8): a key of ``FOLDER_COLORS``, empty for none.
    color: Mapped[str] = mapped_column(String(16), default="", server_default="")
    #: Checked and all items of its checklists (NOTES-6 AC-3); ``None`` while not counted yet.
    tasks_done: Mapped[int | None] = mapped_column(Integer, nullable=True)
    tasks_total: Mapped[int | None] = mapped_column(Integer, nullable=True)
    #: The last change to anything a list shows (``services/notes_list.py``): lists ask for it to load again (EC-6).
    listed_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    #: The paper the note is written on (NOTES-3 AC-17): one of ``PAPERS`` in ``services/notes.py``.
    paper: Mapped[str] = mapped_column(String(8), default="blank", server_default="blank")
    #: The note's symbol before its title (NOTES-3 AC-18): a name of ``services/symbols.py``, empty for none.
    icon: Mapped[str] = mapped_column(String(32), default="", server_default="")
    #: Locked in the vault (NOTES-16): the content lies encrypted in ``sealed_notes`` (``models_vault.py``); ``ydoc``
    #: and ``text`` are empty, only the title stays readable.
    locked: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false(), index=True)


class NoteUpdate(Base):
    """A Yjs update not yet folded into ``Note.ydoc``. Stored before it is passed on to anybody else."""

    __tablename__ = "note_updates"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    note_id: Mapped[str] = mapped_column(ForeignKey("notes.id", ondelete="CASCADE"), index=True)
    update: Mapped[bytes] = mapped_column(LargeBinary)
    account_id: Mapped[int | None] = mapped_column(ForeignKey("accounts.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)


#: What a list of notes shows (NOTES-6): its notes, or the gallery of their attachments (a smart folder with "Anhang",
#: NOTES-7). How the notes look (rows, cards, compact, tiles) is the account's for every list (``LIST_STYLES``), not a
#: folder's: a ``mode`` of ``tiles`` from before is read as ``list``.
LIST_MODES = ("list", "gallery")
#: How the account's lists of notes look, every one of them (``preferences["list_style"]``); the first is the default.
LIST_STYLES = ("list", "cards", "compact", "tiles")
LIST_SORTS = ("updated", "created", "title")
LIST_DIRECTIONS = ("asc", "desc")


class NoteListView(Base):
    """How one account looks at one folder's notes (NOTES-6 AC-4, AC-5), on every device: the sort and the grouping;
    ``mode`` only says whether a smart folder shows its notes or the gallery (``LIST_MODES``). ``key`` is the folder's
    id, or ``all`` for "All notes". No row: newest change first, grouped by date."""

    __tablename__ = "note_list_views"
    __table_args__ = (UniqueConstraint("account_id", "key"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), index=True)
    key: Mapped[str] = mapped_column(String(40))
    mode: Mapped[str] = mapped_column(String(8), default="list")
    sort: Mapped[str] = mapped_column(String(8), default="updated")
    direction: Mapped[str] = mapped_column(String(4), default="desc")
    grouped: Mapped[bool] = mapped_column(Boolean, default=True)
    updated_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow, onupdate=utcnow)

"""MCP connectors (NOTES-20 AC-7): programs that registered to sign in with OAuth, and the codes their accounts gave
them. Nothing secret is stored: only SHA-256 of a code. The keys a connector gets are rows of ``api_tokens``.

Since the shared module mcp (``vendor/nexmcp``): the folders and the address a code was given for, a key's own right per
tool (``McpToolRight``) and a call that waits for its account's answer (``McpRequest``). Only added, never moved."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import JSON, Boolean, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from .models import Base, UtcDateTime, utcnow


class OAuthClient(Base):
    """A program that registered itself (RFC 7591): a public client with PKCE, its name and return addresses."""

    __tablename__ = "oauth_clients"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    redirect_uris: Mapped[list[str]] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    last_used_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)


class OAuthCode(Base):
    """A code an account gave a program on the consent page: traded once for tokens, within ``CODE_MINUTES``."""

    __tablename__ = "oauth_codes"

    code_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    client_id: Mapped[str] = mapped_column(ForeignKey("oauth_clients.id", ondelete="CASCADE"), index=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), index=True)
    redirect_uri: Mapped[str] = mapped_column(String(2048))
    challenge: Mapped[str] = mapped_column(String(128))
    #: ``read`` or ``write``, as the account chose.
    level: Mapped[str] = mapped_column(String(8), default="read")
    expires_at: Mapped[datetime] = mapped_column(UtcDateTime)
    #: The folders the account gave the program; ``None`` for all (module mcp).
    folder_ids: Mapped[Any] = mapped_column(JSON, nullable=True)
    #: The address the program asked for (RFC 8707), empty when it named none.
    resource: Mapped[str] = mapped_column(String(2048), default="")


class OAuthSpent(Base):
    """A code or refresh token of a connector that was traded in already. Brought again, it is a copy in somebody
    else's hands: the whole connector ends (RFC 6749 section 4.1.2, OAuth 2.1 section 4.3.1). Only SHA-256, and only
    the last ``SPENT_KEPT`` of a key; they go with their key."""

    __tablename__ = "oauth_spent"

    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    key_id: Mapped[int] = mapped_column(ForeignKey("api_tokens.id", ondelete="CASCADE"), index=True)
    spent_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)


class McpToolRight(Base):
    """A key's own right for one tool (allow, ask, deny), only where it differs from the group's default."""

    __tablename__ = "mcp_tool_rights"

    key_id: Mapped[int] = mapped_column(ForeignKey("api_tokens.id", ondelete="CASCADE"), primary_key=True)
    tool: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[str] = mapped_column(String(8))


class McpRequest(Base):
    """A call of a tool set to "ask": its arguments fixed (canonical JSON and its SHA-256), waiting for its account's
    answer. It stays when its key goes (the account still sees what was asked)."""

    __tablename__ = "mcp_requests"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), index=True)
    key_id: Mapped[int] = mapped_column(Integer, index=True)
    key_name: Mapped[str] = mapped_column(String(100), default="")
    tool: Mapped[str] = mapped_column(String(64))
    arguments: Mapped[str] = mapped_column(Text)
    digest: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(16), index=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(UtcDateTime)
    decided_at: Mapped[datetime | None] = mapped_column(UtcDateTime, nullable=True)
    decided_by: Mapped[str] = mapped_column(String(200), default="")
    result: Mapped[str | None] = mapped_column(Text, nullable=True)
    summary: Mapped[str] = mapped_column(String(500), default="")
    dangerous: Mapped[bool] = mapped_column(Boolean, default=False)

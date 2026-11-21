"""MCP connectors (NOTES-20 AC-7): programs that registered to sign in with OAuth, and the codes their accounts gave
them. Nothing secret is stored: only SHA-256 of a code. The keys a connector gets are rows of ``api_tokens``."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import JSON, ForeignKey, String
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


class OAuthSpent(Base):
    """A code or refresh token of a connector that was traded in already. Brought again, it is a copy in somebody
    else's hands: the whole connector ends (RFC 6749 section 4.1.2, OAuth 2.1 section 4.3.1). Only SHA-256, and only
    the last ``SPENT_KEPT`` of a key; they go with their key."""

    __tablename__ = "oauth_spent"

    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    key_id: Mapped[int] = mapped_column(ForeignKey("api_tokens.id", ondelete="CASCADE"), index=True)
    spent_at: Mapped[datetime] = mapped_column(UtcDateTime, default=utcnow)

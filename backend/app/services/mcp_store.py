"""nexnotes' side of the shared module mcp (``vendor/nexmcp``, plan "Entwurf MCP-Modul"): its ``Store`` over the
tables nexnotes had (``api_tokens`` for keys and connectors, ``oauth_clients``, ``oauth_codes``, ``oauth_spent``) and
the two it adds (``mcp_tool_rights``, ``mcp_requests``), one class for both modules (it is the ``KeyStore`` of
``schluessel`` too).

⚠️ **Old access merks nothing.** No key is hashed anew, no row moves: MCP keys made by hand (``nn_mcp_``), API tokens
with "also for AI tools" (``nn_api_``) and connected programs (``nn_mcp_``/``nnr_``) keep working; a key is checked by
nexnotes as before (``services/mcp.authenticate``). A connector refreshed before ``oauth_spent`` came still knows its
refresh token before the last one (``refresh_old_hash``). An installation from before that never stored the switch
"MCP-Zugang" keeps it on (decision 5, ``migrate``); a new one starts off.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import delete, func, select, update
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from ..models import TOKEN_MCP, Account, ApiToken, Setting
from ..models_mcp import McpRequest, McpToolRight, OAuthClient, OAuthCode, OAuthSpent
from ..security import account_out
from ..vendor import nexmcp
from ..vendor.nexmcp.model import EXPIRED, WAITING
from . import mcp, settings_service, totp
from .schluessel_store import KeyStore

logger = logging.getLogger("nexnotes.mcp")

#: The module's settings under nexnotes' names.
SETTINGS = {"programs": "mcp_programs", "max_level": "mcp_max_level", "blocked_tools": "mcp_blocked_tools"}
#: The column whose coming marks a database of a version before the module (``migrate``).
MARK = "api_tokens.refreshed_at"


def _aware(moment: datetime | None) -> datetime | None:
    if moment is None:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)


def migrate(engine: Engine, added: list[str]) -> None:
    """Decision 5: "MCP-Zugang" is off on a new installation. A database of before (the column ``MARK`` was added at
    this start) had it on from the start without storing it; that value is written down before the default changes."""
    if MARK not in added:
        return
    with Session(engine) as db:
        if db.get(Setting, "mcp_enabled") is None:
            db.add(Setting(key="mcp_enabled", value=True))
            db.commit()
            logger.info("MCP access stays on as before the update (it was on from the start)")


class McpStore(KeyStore):
    """``nexmcp.Store`` (and ``nexschluessel.Store``) inside one session (one request)."""

    def __init__(self, db: Session) -> None:
        super().__init__(db)

    # --- who calls --------------------------------------------------------------------------------------------------

    def _caller(self, found: mcp.Caller, row: ApiToken) -> nexmcp.Caller:
        return nexmcp.Caller(
            key_id=row.id,
            key_name=row.name,
            account_id=found.account.id,
            account_name=found.account.name,
            level=found.level,
            areas=list(found.folders) if found.folders is not None else None,
            options={},
            rights=self.key_rights(row.id),
            program=bool(row.client_id),
            admin=found.account.role == "operator",
            ai_allowed=True,
            account=found.account,
        )

    def caller(self, token: str) -> nexmcp.Caller | None:
        """nexnotes' own check (``mcp.authenticate``): MCP keys and connectors, API tokens with "also for AI tools",
        run out, blocked, the account out or owing the second factor the operator requires."""
        found = mcp.authenticate(self.db, token)
        if found is None:
            return None
        row = self.db.get(ApiToken, found.key_id)
        return None if row is None else self._caller(found, row)

    def caller_of_key(self, key_id: Any) -> nexmcp.Caller | None:
        row = self._row(key_id)
        if row is None or row.blocked_at is not None:
            return None
        if row.kind != TOKEN_MCP and not row.allow_mcp:
            return None
        account = self.db.get(Account, row.account_id)
        if account is None or account_out(account) or totp.setup_required(self.db, account):
            return None
        self.db.expunge(account)
        folders = [str(chosen) for chosen in row.folder_ids] if row.folder_ids is not None else None
        level = row.level if row.level in mcp.LEVELS else "read"
        return self._caller(mcp.Caller(account=account, key_id=row.id, key_name=row.name, level=level,
                                       folders=folders), row)

    def count_keys(self, account_id: Any) -> int:
        return mcp.count_keys(self.db, int(account_id))

    def account_may(self, account_id: Any) -> bool:
        account = self.db.get(Account, int(account_id))
        return account is not None and not account_out(account) and not totp.setup_required(self.db, account)

    def ai_allowed(self, account_id: Any) -> bool:
        """nexnotes has no "KI erlaubt" per account."""
        return True

    def key_areas(self, account_id: Any) -> list[dict[str, Any]]:
        return [{"id": area.id, "name": area.name} for area in self.areas_of(account_id, "mcp")]

    # --- settings ---------------------------------------------------------------------------------------------------

    def mcp_on(self) -> bool:
        return mcp.allowed(self.db)

    def setting(self, name: str) -> Any:
        row = self.db.get(Setting, SETTINGS[name])
        return None if row is None else row.value

    def set_setting(self, name: str, value: Any) -> None:
        settings_service.save(self.db, {SETTINGS[name]: value}, commit=False)

    def key_rights(self, key_id: Any) -> dict[str, str]:
        rows = self.db.scalars(select(McpToolRight).where(McpToolRight.key_id == int(key_id)))
        return {row.tool: row.value for row in rows}

    def set_key_rights(self, key_id: Any, rights: dict[str, str]) -> None:
        self.db.execute(delete(McpToolRight).where(McpToolRight.key_id == int(key_id)))
        for tool, value in rights.items():
            self.db.add(McpToolRight(key_id=int(key_id), tool=tool, value=value))
        self.db.flush()

    # --- programs (OAuth) -------------------------------------------------------------------------------------------

    def _client(self, row: OAuthClient) -> nexmcp.Client:
        in_use = self.db.scalar(select(ApiToken.id).where(ApiToken.client_id == row.id).limit(1)) is not None
        return nexmcp.Client(id=row.id, name=row.name, redirect_uris=tuple(row.redirect_uris or ()),
                             created_at=_aware(row.created_at) or datetime.now(UTC),
                             last_used_at=_aware(row.last_used_at), in_use=in_use)

    def add_client(self, client: nexmcp.Client) -> None:
        self.db.add(OAuthClient(id=client.id, name=client.name, redirect_uris=list(client.redirect_uris),
                                created_at=client.created_at))
        self.db.flush()

    def client(self, client_id: str) -> nexmcp.Client | None:
        row = self.db.get(OAuthClient, client_id) if client_id and len(client_id) <= 64 else None
        return None if row is None else self._client(row)

    def clients(self) -> list[nexmcp.Client]:
        return [self._client(row) for row in self.db.scalars(select(OAuthClient))]

    def remove_client(self, client_id: str) -> None:
        self.db.execute(delete(OAuthClient).where(OAuthClient.id == client_id))

    def touch_client(self, client_id: str, when: datetime) -> None:
        self.db.execute(update(OAuthClient).where(OAuthClient.id == client_id).values(last_used_at=when))

    def add_code(self, code: nexmcp.Code) -> None:
        self.db.add(OAuthCode(code_hash=code.code_hash, client_id=code.client_id, account_id=int(code.account_id),
                              redirect_uri=code.redirect_uri, challenge=code.challenge, level=code.level,
                              expires_at=code.expires_at, resource=code.resource,
                              folder_ids=[str(area) for area in code.areas] if code.areas is not None else None))
        # Codes nobody traded go with time.
        self.db.execute(delete(OAuthCode).where(OAuthCode.expires_at <= datetime.now(UTC)))
        self.db.flush()

    def take_code(self, code_hash: str) -> nexmcp.Code | None:
        row = self.db.get(OAuthCode, code_hash)
        if row is None:
            return None
        found = nexmcp.Code(code_hash=row.code_hash, client_id=row.client_id, account_id=row.account_id,
                            redirect_uri=row.redirect_uri, challenge=row.challenge, level=row.level,
                            areas=list(row.folder_ids) if row.folder_ids is not None else None, options={},
                            expires_at=_aware(row.expires_at) or datetime.now(UTC), resource=row.resource or "")
        # Taken away first: a code is traded once, even when two requests bring it at the same moment.
        gone = self.db.execute(delete(OAuthCode).where(OAuthCode.code_hash == code_hash)).rowcount
        self.db.commit()
        return found if gone == 1 else None

    def has_program(self, account_id: Any, client_id: str) -> bool:
        return self._program_row(account_id, client_id) is not None

    def _program_row(self, account_id: Any, client_id: str) -> ApiToken | None:
        return self.db.scalar(select(ApiToken).where(ApiToken.account_id == int(account_id),
                                                     ApiToken.kind == TOKEN_MCP, ApiToken.client_id == client_id))

    def program_signed_in(self, account_id: Any, client: nexmcp.Client, *, level: str, areas: list[Any] | None,
                          options: dict[str, bool], grant: nexmcp.Grant, now: datetime) -> Any:
        row = self._program_row(account_id, client.id)
        if row is None:
            row = ApiToken(account_id=int(account_id), kind=TOKEN_MCP, name=client.name, client_id=client.id,
                           token_hash=grant.access_hash, prefix=grant.access_prefix, created_at=now)
            self.db.add(row)
        row.level = level
        row.folder_ids = [str(area) for area in areas] if areas is not None else None
        row.token_hash = grant.access_hash
        row.prefix = grant.access_prefix
        row.expires_at = grant.access_expires
        row.refresh_hash = grant.refresh_hash
        row.refresh_old_hash = None
        row.signed_in_at = now
        row.refreshed_at = now
        self.db.flush()
        return row.id

    def _program(self, row: ApiToken | None) -> nexmcp.Program | None:
        if row is None or not row.client_id:
            return None
        signed = _aware(row.signed_in_at) or _aware(row.created_at) or datetime.now(UTC)
        # Rows of before have no ``refreshed_at``: their access token began at the last refresh, an hour before its end.
        refreshed = _aware(row.refreshed_at)
        if refreshed is None and row.expires_at is not None:
            refreshed = _aware(row.expires_at) - timedelta(hours=mcp_config().access_hours)  # type: ignore[operator]
        return nexmcp.Program(key_id=row.id, account_id=row.account_id, client_id=row.client_id,
                              signed_in_at=signed, refreshed_at=refreshed or signed)

    def program_by_refresh(self, refresh_hash: str) -> nexmcp.Program | None:
        row = self.db.scalar(select(ApiToken).where(ApiToken.refresh_hash == refresh_hash, ApiToken.kind == TOKEN_MCP,
                                                    ApiToken.client_id.is_not(None), ApiToken.blocked_at.is_(None)))
        return self._program(row)

    def program_of_token(self, token_hash: str) -> nexmcp.Program | None:
        row = self.db.scalar(select(ApiToken).where(ApiToken.kind == TOKEN_MCP, ApiToken.client_id.is_not(None),
                                                    (ApiToken.refresh_hash == token_hash)
                                                    | (ApiToken.token_hash == token_hash)))
        return self._program(row)

    def program_refreshed(self, key_id: Any, grant: nexmcp.Grant, now: datetime) -> None:
        row = self._row(key_id)
        if row is None:
            return
        row.token_hash = grant.access_hash
        row.prefix = grant.access_prefix
        row.expires_at = grant.access_expires
        row.refresh_hash = grant.refresh_hash
        row.refresh_old_hash = None
        row.refreshed_at = now
        self.db.flush()

    def spend(self, key_id: Any, token_hash: str, keep: int) -> None:
        self.db.merge(OAuthSpent(token_hash=token_hash, key_id=int(key_id), spent_at=datetime.now(UTC)))
        self.db.flush()
        kept = (select(OAuthSpent.token_hash).where(OAuthSpent.key_id == int(key_id))
                .order_by(OAuthSpent.spent_at.desc(), OAuthSpent.token_hash).limit(keep))
        self.db.execute(delete(OAuthSpent).where(OAuthSpent.key_id == int(key_id),
                                                 OAuthSpent.token_hash.not_in(kept)))

    def spent_by(self, token_hash: str) -> Any:
        spent = self.db.get(OAuthSpent, token_hash)
        if spent is not None:
            return spent.key_id
        # Connectors refreshed before ``oauth_spent`` came still know the refresh token before their last one.
        return self.db.scalar(select(ApiToken.id).where(ApiToken.refresh_old_hash == token_hash,
                                                        ApiToken.kind == TOKEN_MCP))

    def end_program(self, key_id: Any) -> None:
        self.db.execute(delete(ApiToken).where(ApiToken.id == int(key_id), ApiToken.kind == TOKEN_MCP))
        self.db.flush()

    # --- requests ---------------------------------------------------------------------------------------------------

    @staticmethod
    def _request(row: McpRequest | None) -> nexmcp.Request | None:
        if row is None:
            return None
        return nexmcp.Request(id=row.id, account_id=row.account_id, key_id=row.key_id, key_name=row.key_name,
                              tool=row.tool, arguments=row.arguments, digest=row.digest, status=row.status,
                              created_at=_aware(row.created_at) or datetime.now(UTC),
                              expires_at=_aware(row.expires_at) or datetime.now(UTC),
                              decided_at=_aware(row.decided_at), decided_by=row.decided_by or "", result=row.result,
                              summary=row.summary or "", dangerous=bool(row.dangerous))

    def add_request(self, request: nexmcp.Request) -> nexmcp.Request:
        row = McpRequest(account_id=int(request.account_id), key_id=int(request.key_id),
                         key_name=(request.key_name or "")[:100], tool=request.tool, arguments=request.arguments,
                         digest=request.digest, status=request.status, created_at=request.created_at,
                         expires_at=request.expires_at, summary=(request.summary or "")[:500],
                         dangerous=request.dangerous)
        self.db.add(row)
        self.db.flush()
        found = self._request(row)
        assert found is not None
        return found

    def request(self, request_id: Any) -> nexmcp.Request | None:
        try:
            number = int(request_id)
        except (TypeError, ValueError):
            return None
        return self._request(self.db.get(McpRequest, number))

    def requests_of(self, account_id: Any) -> list[nexmcp.Request]:
        rows = self.db.scalars(select(McpRequest).where(McpRequest.account_id == int(account_id))
                               .order_by(McpRequest.id.desc()))
        return [found for row in rows if (found := self._request(row)) is not None]

    def count_waiting(self, account_id: Any, key_id: Any = None) -> int:
        query = select(func.count()).select_from(McpRequest).where(McpRequest.account_id == int(account_id),
                                                                   McpRequest.status == WAITING)
        if key_id is not None:
            query = query.where(McpRequest.key_id == int(key_id))
        return int(self.db.scalar(query) or 0)

    def claim(self, request_id: Any, status: str, *, now: datetime, by: str = "") -> bool:
        changed = self.db.execute(update(McpRequest)
                                  .where(McpRequest.id == int(request_id), McpRequest.status == WAITING)
                                  .values(status=status, decided_at=now, decided_by=by[:200]))
        return changed.rowcount == 1

    def finish(self, request_id: Any, status: str, result: str | None, now: datetime) -> None:
        self.db.execute(update(McpRequest).where(McpRequest.id == int(request_id))
                        .values(status=status, result=result, decided_at=now))

    def expire(self, now: datetime) -> int:
        changed = self.db.execute(update(McpRequest)
                                  .where(McpRequest.status == WAITING, McpRequest.expires_at <= now)
                                  .values(status=EXPIRED, decided_at=now))
        return int(changed.rowcount or 0)


def mcp_config() -> nexmcp.AppConfig:
    return mcp.CONFIG

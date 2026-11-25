"""Who reads system mail in which language, and whether a mail server is set up. Every mail itself is the shared
post module's (``vendor/nexpost`` 1.1.0, since then without a mailer of nexnotes' own): written there, sent at once
(``outbox.deliver_now``: the invitation, "Forgot your password?"; the test mail ``outbox.test_mail``) or through
the outbox (``services/kontenpost``, ``services/post_store``).

Off until the operator enters a server: the link to copy is always enough. All go out in the language of whoever
receives it: the receiver's account language, else their browser's at the last sign-in; else whoever sends the mail
off (their account, their page, their browser); else the instance's, which is its first operator's; else English.
"""

from __future__ import annotations

import logging
import re
import unicodedata

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import OPERATOR, Account
from . import settings_service

logger = logging.getLogger("nexnotes.mail")

TIMEOUT = 15
SECURITY = ("starttls", "tls", "none")


def configured(db: Session) -> bool:
    values = settings_service.get_all(db)
    return bool(values["smtp_host"] and values["smtp_from"])


#: The languages nexnotes writes mail in (the shared post module has the texts); any other gets English.
MAIL_LANGUAGES = ("de", "en")


#: The first language of an ``Accept-Language`` header: ``de`` from ``de-DE,de;q=0.9,en;q=0.8``.
_FIRST_LANGUAGE = re.compile(r"\s*([A-Za-z]{2,3})(?:[-_][A-Za-z0-9]{1,8})*\s*(?:[;,]|$)")


def note_browser_language(account: Account, header: str) -> None:
    """Remembers the browser's language at a sign-in, for a mail to the account while it has no language of its own.
    Stored with the session the sign-in starts; a header without a language keeps what was known."""
    found = _FIRST_LANGUAGE.match(header or "")
    if found:
        account.browser_language = found.group(1).lower()


def mail_language(*choices: str | None) -> str:
    """The first of ``choices`` nexnotes has mail texts for (``de-AT`` counts as ``de``); English otherwise."""
    for choice in choices:
        code = (choice or "").split("-")[0].split("_")[0].strip().lower()
        if code in MAIL_LANGUAGES:
            return code
    return "en"


def languages(account: Account | None, page: str = "") -> tuple[str, ...]:
    """What a person reads, best first: the account's language, the page they are on, their browser at the last
    sign-in."""
    if account is None:
        return (page,)
    return account.language, page, account.browser_language


def instance_languages(db: Session) -> tuple[str, ...]:
    """nexnotes has no language of its own: the first operator's stands for it (chosen when setting it up)."""
    first = db.scalar(select(Account).where(Account.role == OPERATOR).order_by(Account.id).limit(1))
    return languages(first)


def language_for(db: Session, receiver: Account | None, *fallback: str) -> str:
    """The language of a mail: the receiver's account, else ``fallback`` (whoever sends it off and their page), else
    the instance's, else English."""
    return mail_language(*languages(receiver), *fallback, *instance_languages(db))


def one_line(text: str) -> str:
    """A name in a mail: one line, no control characters (C0, DEL, C1, line and paragraph separators)."""
    return " ".join("".join(" " if unicodedata.category(char) in {"Cc", "Zl", "Zp"} else char for char in text).split())


def old_code(code: str) -> str:
    """The code nexnotes answered a failed mail with before post 1.1.0 (``mail_off`` or ``mail_failed``); the post
    module's own reason goes with it as ``mail_code``."""
    return "mail_off" if code == "mail_off" else "invalid_email" if code == "mail_address_invalid" else "mail_failed"

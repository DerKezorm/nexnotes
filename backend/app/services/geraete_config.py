"""nexnotes' devices as the module geraete knows them (``vendor/nexgeraete``, ``geraete/NACHZIEHEN.md``, nexnotes):
the form ``nex`` of the published iPhone app, the prefix ``nnd_``, the push relay of the operator's setting with the
``info`` the app decrypts with, and the two kinds the published app knows (``changed``, ``trashed``). The rows stay in
nexnotes' tables (``services/geraete_store.py``)."""

from __future__ import annotations

from ..vendor import nexgeraete
from . import apppush
from .history import Clock

#: Somebody changed a shared note with notifications switched on (NOTES-14).
CHANGED = nexgeraete.PushKind(
    id="changed",
    title={"de": "Änderungen in geteilten Notizen", "en": "Changes in shared notes",
           "fr": "Modifications de notes partagées"},
    hint={"de": "Wenn jemand eine geteilte Notiz ändert, für die du Mitteilungen eingeschaltet hast.",
          "en": "When somebody changes a shared note you switched notifications on for.",
          "fr": "Quand quelqu'un modifie une note partagée pour laquelle tu as activé les notifications."},
)
#: Somebody put such a note in the trash (NOTES-14 EC-7).
TRASHED = nexgeraete.PushKind(
    id="trashed",
    title={"de": "Geteilte Notiz im Papierkorb", "en": "Shared note in the trash",
           "fr": "Note partagée dans la corbeille"},
    hint={"de": "Wenn jemand eine solche Notiz in den Papierkorb legt.",
          "en": "When somebody puts such a note in the trash.",
          "fr": "Quand quelqu'un met une telle note dans la corbeille."},
)

#: The clock of the module's routes: the real one; the contract tests move it on (``nexgeraete_adapter.travel``).
clock = Clock()

CONFIG = nexgeraete.AppConfig(
    app="nexnotes",
    scheme="nexnotes",
    token_prefix="nnd_",
    form=nexgeraete.FORM_NEX,
    # No App Store page yet: the window shows the code and the steps without the link.
    app_store_url="",
    # The operator's setting (``NEXNOTES_PUSH_RELAY``); empty: nothing goes out.
    relay_url=apppush.relay_url,
    push_info="nexnotes-push-v1",
    kinds=(CHANGED, TRASHED),
    legacy_kinds=("changed", "trashed"),
    server_id=apppush.server_id,
)

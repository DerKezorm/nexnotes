"""A device of the vault (NOTES-16), played in Python: the same derivation, wrapping and encryption the browser does
with WebCrypto (``frontend/src/vault/crypto.ts``) and the iOS app will do with CryptoKit and CommonCrypto.

- PBKDF2-HMAC-SHA-256 over the password and the vault's salt gives 32 bytes; HKDF-SHA-256 (no salt) makes of them
  the key that wraps the vault key (``nexnotes vault kek v1``) and the check value for the server
  (``nexnotes vault auth v1``).
- The vault key is 32 random bytes, wrapped with AES-256-GCM (AAD ``nexnotes vault key v1|<account>``).
- Each note has its own key: HKDF-SHA-256 of the vault key with ``nexnotes note v1|<note>``.
- A sealed part: ``0x01``, a 12-byte nonce, the ciphertext with its tag; AAD ``nexnotes sealed v1|note|<note>`` for the
  content and the versions, ``nexnotes sealed v1|attachment|<note>|<attachment>`` for an attachment, whose plain
  bytes are the length of a JSON header (4 bytes, big-endian), the header ``{"name", "mime"}`` and the file.
"""

from __future__ import annotations

import base64
import json
import os
import struct
from dataclasses import dataclass
from functools import cache
from typing import Any

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from fastapi.testclient import TestClient

ITERATIONS = 600_000
FORMAT = b"\x01"


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def unb64(text: str) -> bytes:
    return base64.b64decode(text)


def _hkdf(key: bytes, info: str) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=info.encode()).derive(key)


@cache
def derive(password: str, salt: bytes, iterations: int = ITERATIONS) -> tuple[bytes, bytes]:
    """The wrapping key and the check value of a password (cached: PBKDF2 takes its time on purpose)."""
    master = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=iterations).derive(
        password.encode())
    return _hkdf(master, "nexnotes vault kek v1"), _hkdf(master, "nexnotes vault auth v1")


def seal(key: bytes, data: bytes, aad: str) -> bytes:
    nonce = os.urandom(12)
    return FORMAT + nonce + AESGCM(key).encrypt(nonce, data, aad.encode())


def unseal(key: bytes, blob: bytes, aad: str) -> bytes:
    assert blob[:1] == FORMAT
    return AESGCM(key).decrypt(blob[1:13], blob[13:], aad.encode())


def note_key(vault_key: bytes, note_id: str) -> bytes:
    return _hkdf(vault_key, f"nexnotes note v1|{note_id}")


def note_aad(note_id: str) -> str:
    return f"nexnotes sealed v1|note|{note_id}"


def attachment_aad(note_id: str, attachment_id: str) -> str:
    return f"nexnotes sealed v1|attachment|{note_id}|{attachment_id}"


def pack(name: str, mime: str, data: bytes) -> bytes:
    header = json.dumps({"name": name, "mime": mime}).encode()
    return struct.pack(">I", len(header)) + header + data


def unpack(data: bytes) -> tuple[dict[str, Any], bytes]:
    (length,) = struct.unpack(">I", data[:4])
    return json.loads(data[4:4 + length]), data[4 + length:]


def kdf_of(salt: bytes, iterations: int = ITERATIONS) -> dict[str, Any]:
    return {"name": "PBKDF2", "hash": "SHA-256", "iterations": iterations, "salt": b64(salt)}


@dataclass
class Device:
    """One browser or app of an account: the client, and the vault key once opened."""

    client: TestClient
    account_id: int
    key: bytes | None = None
    epoch: int = 0

    # --- the vault ---

    def wrap(self, password: str, vault_key: bytes, salt: bytes | None = None) -> dict[str, Any]:
        salt = salt or os.urandom(16)
        kek, auth = derive(password, salt)
        wrapped = seal(kek, vault_key, f"nexnotes vault key v1|{self.account_id}")
        return {"kdf": kdf_of(salt), "wrapped_key": b64(wrapped), "auth": b64(auth)}

    def setup(self, password: str) -> dict[str, Any]:
        vault_key = os.urandom(32)
        answer = self.client.post("/api/vault/setup", json={**self.wrap(password, vault_key), "understood": True})
        assert answer.status_code == 201, answer.text
        self.key, self.epoch = vault_key, answer.json()["epoch"]
        return answer.json()

    def auth_of(self, password: str) -> str:
        status = self.client.get("/api/vault").json()
        _kek, auth = derive(password, unb64(status["kdf"]["salt"]), status["kdf"]["iterations"])
        return b64(auth)

    def try_open(self, password: str) -> Any:
        status = self.client.get("/api/vault").json()
        kek, auth = derive(password, unb64(status["kdf"]["salt"]), status["kdf"]["iterations"])
        answer = self.client.post("/api/vault/unlock", json={"auth": b64(auth)})
        if answer.status_code == 200:
            body = answer.json()
            self.key = unseal(kek, unb64(body["wrapped_key"]), f"nexnotes vault key v1|{self.account_id}")
            self.epoch = body["epoch"]
        return answer

    def open(self, password: str) -> bytes:
        answer = self.try_open(password)
        assert answer.status_code == 200, answer.text
        assert self.key is not None
        return self.key

    def forget(self) -> None:
        self.key = None

    # --- notes ---

    def nkey(self, note_id: str) -> bytes:
        assert self.key is not None, "the vault is not open"
        return note_key(self.key, note_id)

    def lock(self, note_id: str, *, keep: set[str] = frozenset()) -> dict[str, Any]:
        """Locks a note the way the browser does: start, encrypt every part, lay it down, finish. ``keep``: parts not
        sent (for the tests of an incomplete lock)."""
        start = self.client.post(f"/api/vault/notes/{note_id}/lock/start")
        assert start.status_code == 200, start.text
        body = start.json()
        key = self.nkey(note_id)
        parts: dict[str, bytes] = {"content": seal(key, unb64(body["state"]), note_aad(note_id))}
        for version in body["versions"]:
            parts[f"version:{version['id']}"] = seal(key, unb64(version["state"]), note_aad(note_id))
        for attachment_id in body["attachments"]:
            info = self.client.get(f"/api/attachments/{attachment_id}").json()
            data = self.client.get(f"/api/attachments/{attachment_id}/file").content
            parts[f"attachment:{attachment_id}"] = seal(key, pack(info["name"], info["mime"], data),
                                                        attachment_aad(note_id, attachment_id))
        for part, data in parts.items():
            if part in keep:
                continue
            laid = self.client.put("/api/vault/stage", params={"note": note_id, "step": "lock", "part": part},
                                   content=data)
            assert laid.status_code == 200, laid.text
        return self.client.post(f"/api/vault/notes/{note_id}/lock").json() if not keep else body

    def read(self, note_id: str) -> tuple[bytes, int]:
        """The plain Yjs state and the revision of a locked note."""
        answer = self.client.get(f"/api/vault/notes/{note_id}")
        assert answer.status_code == 200, answer.text
        body = answer.json()
        return unseal(self.nkey(note_id), unb64(body["content"]), note_aad(note_id)), body["rev"]

    def save(self, note_id: str, state: bytes, base_rev: int, title: str = "", **extra: Any) -> Any:
        return self.client.post("/api/vault/save", json={
            "note": note_id, "content": b64(seal(self.nkey(note_id), state, note_aad(note_id))),
            "base_rev": base_rev, "epoch": extra.pop("epoch", self.epoch), "title": title, **extra})

    def unlock(self, note_id: str) -> dict[str, Any]:
        """"Sperre aufheben" the way the browser does it."""
        start = self.client.post(f"/api/vault/notes/{note_id}/unlock/start")
        assert start.status_code == 200, start.text
        body = start.json()
        key = self.nkey(note_id)
        parts = {"content": unseal(key, unb64(body["content"]), note_aad(note_id))}
        for version in body["versions"]:
            parts[f"version:{version['id']}"] = unseal(key, unb64(version["content"]), note_aad(note_id))
        names: dict[str, str] = {}
        for attachment_id in body["attachments"]:
            sealed = self.client.get(f"/api/attachments/{attachment_id}/file").content
            header, data = unpack(unseal(key, sealed, attachment_aad(note_id, attachment_id)))
            names[attachment_id] = header["name"]
            parts[f"attachment:{attachment_id}"] = data
        for part, data in parts.items():
            laid = self.client.put("/api/vault/stage", params={"note": note_id, "step": "unlock", "part": part},
                                   content=data)
            assert laid.status_code == 200, laid.text
        done = self.client.post(f"/api/vault/notes/{note_id}/unlock", json={"names": names})
        assert done.status_code == 200, done.text
        return done.json()

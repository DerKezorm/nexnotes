"""Profile pictures, as in the other nex apps: what comes in is a picture of any kind a phone or camera makes; what is
kept is a square WebP of ``SIZE`` pixels, drawn anew. Nothing of the file that came survives but its pixels: no place,
no device, no hidden second picture, no script in an SVG (an SVG is not taken at all).

Kept in the database next to the account (a few kilobytes), so every backup carries it, and an account deleted for
good takes it along.

Seen by every signed-in account (decided for every nex app, konten 1.0.0: a picture is no secret among the people
of one server); nobody signed out.
"""

from __future__ import annotations

import io
import logging
import struct
import threading

from sqlalchemy.orm import Session

from ..models import Account

logger = logging.getLogger("nexnotes.accounts")

SIZE = 256
#: Larger than any photo a phone takes; above it the file is not even opened.
MAX_BYTES = 20 * 1024 * 1024
#: Pixels of the picture that came (a 1-bit PNG can be tiny on disk and huge in memory).
MAX_PIXELS = 50_000_000
#: One picture at a time: a large photo takes a few hundred MB while it is read, and several at once would press the
#: server.
_ONE_AT_A_TIME = threading.Lock()
#: What phones and cameras make. The decoder opens more (TIFF, PSD, EPS, which would start Ghostscript): not here.
KINDS = {"jpeg", "png", "webp", "gif", "bmp", "heic", "avif"}
_AVIF = {b"avif", b"avis"}
_HEIF = {b"heic", b"heix", b"hevc", b"hevx", b"heim", b"heis", b"mif1", b"msf1"}

#: The English sentence for each code, for whoever uses the API directly; the page builds its own from the code.
MESSAGES = {
    "avatar_too_large": "The picture is too large.",
    "avatar_not_a_picture": "That is not a picture nexnotes accepts (JPEG, PNG, WebP, GIF, HEIC or AVIF).",
}


class AvatarError(ValueError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code
        self.message = MESSAGES[code]


def sniff(head: bytes) -> str | None:
    """The kind of a file by its first bytes, never by its name."""
    if head.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    if head.startswith((b"GIF87a", b"GIF89a")):
        return "gif"
    if head.startswith(b"BM") and len(head) > 14:
        return "bmp"
    if len(head) >= 12 and head[4:8] == b"ftyp":
        size = struct.unpack(">I", head[:4])[0]
        brands = {head[8:12]} | {head[at : at + 4] for at in range(16, min(size, len(head)) - 3, 4)}
        if brands & _AVIF:
            return "avif"
        if brands & _HEIF:
            return "heic"
    return None


def make(data: bytes) -> bytes:
    """The square WebP of a picture, upright and cut to its middle. ``AvatarError`` for anything else."""
    if len(data) > MAX_BYTES:
        raise AvatarError("avatar_too_large")
    if sniff(data[:64]) not in KINDS:
        raise AvatarError("avatar_not_a_picture")
    import pillow_heif
    from PIL import Image, ImageOps

    try:
        pillow_heif.register_heif_opener()
        with _ONE_AT_A_TIME, Image.open(io.BytesIO(data)) as image:
            if image.width * image.height > MAX_PIXELS:
                raise AvatarError("avatar_too_large")
            # Made small first, while reading where the format allows (a JPEG at an eighth), so that only one copy of
            # the full picture is ever in memory; turned upright and cut afterwards.
            image.draft("RGB", (SIZE * 4, SIZE * 4))
            image.thumbnail((SIZE * 4, SIZE * 4), Image.Resampling.LANCZOS)
            upright = ImageOps.exif_transpose(image)
            square = ImageOps.fit(upright.convert("RGBA"), (SIZE, SIZE), Image.Resampling.LANCZOS)
            out = io.BytesIO()
            square.save(out, "WEBP", quality=85, method=4, exif=b"", xmp=b"")
            return out.getvalue()
    except AvatarError:
        raise
    except Image.DecompressionBombError as exc:
        # Over Pillow's own limit: too large, not "no picture".
        raise AvatarError("avatar_too_large") from exc
    except Exception as exc:
        # A broken or hostile picture fails in the decoder's own way.
        logger.info("A profile picture could not be read: %s", type(exc).__name__)
        raise AvatarError("avatar_not_a_picture") from exc


def may_see(db: Session, viewer: Account, owner_id: int) -> bool:
    """Every signed-in account sees every picture (konten 1.0.0, ``picture_status`` of the contract); the route
    itself lets nobody signed out in."""
    del db, viewer, owner_id
    return True

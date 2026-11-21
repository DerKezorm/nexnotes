"""What a file is, decided from its content, and what the browser gets to see of it (NOTES-10).

* **The kind comes from the first bytes**, never from the name or the type the browser claims (``kind_of``): a
  picture is one of the formats of the profile pictures (``avatars.sniff``), a PDF begins with ``%PDF-``, a video is an
  ISO media file of a video brand or a WebM/Matroska file and has a video stream. Everything else is a "file": only
  downloaded, never shown in the page (HTML, SVG, XML, programs, office files, archives).
* **A picture is kept without EXIF, XMP, comments, place or device**, upright, in the same format (a BMP as PNG). A
  JPEG that stands upright loses its metadata segments and whatever follows the picture, without being encoded again
  (``strip_jpeg``); a HEIC or AVIF keeps its pictures (depth, HDR) and only has its EXIF and XMP blanked where they lie
  (``blank_heif``), so that the original is there to download (EC-3) as it was taken. Everything else, and a JPEG that
  must be turned, is drawn anew from its pixels. A WebP of at most ``VIEW_EDGE`` pixels is what every browser shows, a
  WebP of ``THUMB_EDGE`` the preview. An animation is drawn anew frame by frame only up to ``MAX_ANIMATION_PIXELS``.
* **A PDF** gets its number of pages and a picture of its first page (pdfium).
* **A video** gets its length, its size and a picture (ffprobe, ffmpeg; without them the browser shows the first frame
  itself). It is not encoded again.

**Never in the server's process.** ``prepare`` hands the work to a worker with limits of memory and time
(``media_worker``; the picture of a link card goes there too); a file that goes past them is kept as a file without a
preview (``Prepared.preview_failed``). ``prepare_here`` is what the worker runs.

Nothing here knows notes or the database.
"""

from __future__ import annotations

import io
import json
import logging
import shutil
import struct
import subprocess
import tempfile
import uuid
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import avatars

logger = logging.getLogger("nexnotes.attachments")

#: The longest edge of the picture the browser shows, and of the preview, in pixels.
VIEW_EDGE = 2048
THUMB_EDGE = 480
#: Pixels of a picture that is still drawn; above it the file is kept as a file (a 1-bit PNG can be tiny on disk and
#: huge in memory).
MAX_PIXELS = 80_000_000
#: Pixels of all frames of an animation together that are still drawn anew (a GIF of 5 KB can hold a thousand frames
#: of full size).
MAX_ANIMATION_PIXELS = 100_000_000
#: Seconds ffprobe and ffmpeg may take for one video.
VIDEO_SECONDS = 30
#: Seconds the worker may take for a picture and for a PDF (pdfium's first page) before the file stays without preview.
PICTURE_SECONDS = 60
PDF_SECONDS = 10

IMAGE = "image"
VIDEO = "video"
PDF = "pdf"
FILE = "file"
#: The type each picture format is given out with once drawn anew.
IMAGE_TYPES = {"jpeg": "image/jpeg", "png": "image/png", "webp": "image/webp", "gif": "image/gif",
               "heic": "image/heic", "avif": "image/avif", "bmp": "image/png"}
#: Formats every browser shows itself; HEIC and AVIF are shown through the WebP view only.
SHOWN = {"jpeg", "png", "webp", "gif"}
#: ISO media brands of videos (MP4, QuickTime, 3GP). Audio-only brands (M4A, M4B) are files.
_VIDEO_BRANDS = {b"isom", b"iso2", b"iso3", b"iso4", b"iso5", b"iso6", b"mp41", b"mp42", b"avc1", b"M4V ", b"M4VP",
                 b"mmp4", b"MSNV", b"dash", b"qt  ", b"3gp4", b"3gp5", b"3gp6", b"3g2a", b"f4v "}
_EBML = b"\x1a\x45\xdf\xa3"
_heif_ready = False


@dataclass
class Prepared:
    """What the server makes of a file."""

    kind: str
    mime: str = "application/octet-stream"
    inline: bool = False
    width: int | None = None
    height: int | None = None
    pages: int | None = None
    duration_ms: int | None = None
    #: The file drawn anew, to keep in place of what came (pictures).
    redrawn: bytes | None = None
    #: The same as a file beside the upload's work file, for what is too large for memory (a recording made anew).
    redrawn_file: str | None = None
    view: bytes | None = None
    thumb: bytes | None = None
    #: The name's ending changed with the format (a BMP kept as PNG).
    suffix: str | None = None
    notes: list[str] = field(default_factory=list)
    #: Reading it went past the limits (pixels, memory, time): kept as a file to download, without a preview.
    preview_failed: bool = False


def _heif() -> None:
    global _heif_ready
    if not _heif_ready:
        import pillow_heif

        pillow_heif.register_heif_opener()
        _heif_ready = True


def _brands(head: bytes) -> set[bytes]:
    if len(head) < 12 or head[4:8] != b"ftyp":
        return set()
    size = struct.unpack(">I", head[:4])[0]
    return {head[8:12]} | {head[at: at + 4] for at in range(16, min(size, len(head)) - 3, 4)}


def kind_of(head: bytes) -> tuple[str, str]:
    """The kind of a file and its format, from its first bytes (at least 64, better 4096)."""
    picture = avatars.sniff(head[:64])
    if picture is not None:
        return IMAGE, picture
    if head.lstrip(b"\r\n\t ")[:5] == b"%PDF-":
        return PDF, "pdf"
    if _brands(head) & _VIDEO_BRANDS:
        return VIDEO, "mov" if b"qt  " in _brands(head) else "mp4"
    if head.startswith(_EBML):
        return VIDEO, "webm" if b"webm" in head[:64] else "matroska"
    return FILE, ""


def _seconds(kind: str, role: str | None) -> float:
    from . import sketches

    if role == "recording":
        return 2 * sketches.SOUND_SECONDS + 15
    if role == "transcript":
        return 30
    if kind == PDF:
        return PDF_SECONDS
    if kind == VIDEO:
        return 2 * VIDEO_SECONDS + 15
    return PICTURE_SECONDS


def prepare(path: Path, role: str | None = None) -> Prepared:
    """What the file at ``path`` is and what the browser gets of it, read in a worker (``media_worker``). Without a
    role a file the limits stopped is a file to download without a preview; with a role (NOTES-18)
    ``media_worker.MediaFailed`` and ``sketches.WrongKind`` reach the caller."""
    from . import media_worker, sketches

    with open(path, "rb") as handle:
        head = handle.read(4096)
    kind, _form = kind_of(head)
    if role is None and kind == FILE:
        return Prepared(kind=FILE)
    if role is not None and sketches.ROLES.get(role) == sketches.DRAWING_DATA:
        return sketches.prepare(path, role)
    try:
        prepared: Prepared = media_worker.run("app.services.media:prepare_any", str(path), role,
                                              seconds=_seconds(kind, role))
    except media_worker.MediaFailed as exc:
        if role is not None:
            raise
        logger.warning("An attachment was kept without a preview kind=%s reason=%s", kind, exc.reason)
        return Prepared(kind=FILE, preview_failed=True, notes=[exc.reason])
    return prepared


def prepare_any(path: str, role: str | None) -> Prepared:
    """In the worker: ``prepare_here``, or by the role the device gave (``sketches.prepare``)."""
    if role is None:
        return prepare_here(Path(path))
    from . import sketches

    return sketches.prepare(Path(path), role)


#: A C++ exception leaving a library, as Windows reports it (0xE06D7363, signed and unsigned).
_CPP_EXCEPTION = (0xE06D7363, 0xE06D7363 - 2**32)


def prepare_here(path: Path) -> Prepared:
    """What the file at ``path`` is and what the browser gets of it, in this process. Never raises for a broken or
    hostile file: what cannot be read is a file to download."""
    with open(path, "rb") as handle:
        head = handle.read(4096)
    kind, form = kind_of(head)
    try:
        if kind == IMAGE:
            return _picture(path, form)
        if kind == PDF:
            return _pdf(path)
        if kind == VIDEO:
            return _video(path, form)
    except MemoryError:
        # Past the worker's memory: the worker ends, and the file stays without a preview.
        raise
    except OSError as exc:
        if getattr(exc, "winerror", None) in _CPP_EXCEPTION:
            # pdfium's std::bad_alloc, as Windows hands it through ctypes: the memory ran out as well.
            raise MemoryError from exc
        logger.info("An attachment could not be read as %s: %s", kind, type(exc).__name__)
        return Prepared(kind=FILE, notes=[type(exc).__name__])
    except Exception as exc:  # noqa: BLE001 - a hostile file fails in the decoder's own way
        logger.info("An attachment could not be read as %s: %s", kind, type(exc).__name__)
        return Prepared(kind=FILE, notes=[type(exc).__name__])
    return Prepared(kind=FILE)


# --- Pictures -----------------------------------------------------------------------------------------------------


def _webp(image: Any, edge: int, quality: int) -> bytes:
    from PIL import Image

    copy = image.copy()
    copy.thumbnail((edge, edge), Image.Resampling.LANCZOS)
    if copy.mode not in ("RGB", "RGBA"):
        copy = copy.convert("RGBA" if "A" in copy.getbands() or copy.mode == "P" else "RGB")
    out = io.BytesIO()
    copy.save(out, "WEBP", quality=quality, method=4, exif=b"", xmp=b"")
    return out.getvalue()


def _too_much(note: str) -> Prepared:
    return Prepared(kind=FILE, preview_failed=True, notes=[note])


def _picture(path: Path, form: str) -> Prepared:
    from PIL import Image, ImageOps

    _heif()
    with Image.open(path) as image:
        if image.width * image.height > MAX_PIXELS:
            return _too_much("too many pixels")
        # Counting the frames of a GIF reads their headers, not their pixels. WebP and APNG are kept as their first
        # frame only (``exif_transpose`` and ``load`` read that one).
        frames = getattr(image, "n_frames", 1)
        if form == "gif" and frames > 1 and image.width * image.height * frames > MAX_ANIMATION_PIXELS:
            return _too_much("too many pixels in the animation")
        icc = image.info.get("icc_profile")
        if form == "gif" and frames > 1:
            redrawn = _redraw_animation(image)
            first = image.copy().convert("RGBA")
            upright = first
        else:
            kept = _kept_as_it_is(path, form, image)
            upright = ImageOps.exif_transpose(image)
            upright.load()
            redrawn = kept if kept is not None else _redraw(upright, form, icc)
        width, height = upright.size
        view = None
        if form not in SHOWN or max(width, height) > VIEW_EDGE:
            view = _webp(upright, VIEW_EDGE, 82)
        thumb = _webp(upright, THUMB_EDGE, 75)
    return Prepared(kind=IMAGE, mime=IMAGE_TYPES[form], inline=form in SHOWN or form == "bmp", width=width,
                    height=height, redrawn=redrawn, view=view, thumb=thumb,
                    suffix=".png" if form == "bmp" else None)


def _kept_as_it_is(path: Path, form: str, image: Any) -> bytes | None:
    """The file without its metadata but not encoded again, where that can be done (an upright JPEG, a HEIC, an
    AVIF), checked to read as the same picture; ``None`` to draw it anew."""
    from PIL import Image

    try:
        if form == "jpeg":
            if image.getexif().get(0x0112, 1) != 1:
                return None
            kept = strip_jpeg(path.read_bytes())
            if kept is None:
                return None
            with Image.open(io.BytesIO(kept)) as check:
                same = check.format == "JPEG" and check.size == image.size
                check.draft("RGB", (max(1, check.width // 8), max(1, check.height // 8)))
                check.load()
            return kept if same else None
        if form in ("heic", "avif"):
            kept = blank_heif(path.read_bytes())
            if kept is None:
                return None
            with Image.open(io.BytesIO(kept)) as check:
                same = check.size == image.size
            return kept if same else None
    except MemoryError:
        # Past the worker's memory: the worker ends, and the file stays without a preview.
        raise
    except Exception:  # noqa: BLE001 - what cannot be kept as it is is drawn anew
        logger.info("A picture is drawn anew instead of kept as it is form=%s", form)
    return None


#: What a picture keeps of its ``info`` when it is drawn anew: how it is drawn; nothing of where, who or what.
_DRAWING_INFO = ("transparency", "duration", "loop", "background", "disposal")


def _clean_info(image: Any) -> None:
    image.info = {key: value for key, value in image.info.items() if key in _DRAWING_INFO}


def _redraw(image: Any, form: str, icc: bytes | None) -> bytes:
    """The picture in its own format again, from its pixels alone (the colour profile kept; no EXIF, no XMP, no
    comment)."""
    _clean_info(image)
    out = io.BytesIO()
    extra: dict[str, Any] = {"icc_profile": icc} if icc else {}
    if form == "jpeg":
        image.convert("RGB").save(out, "JPEG", quality=92, optimize=True, **extra)
    elif form in ("png", "bmp"):
        image.save(out, "PNG", **extra)
    elif form == "webp":
        image.save(out, "WEBP", quality=92, method=4, exif=b"", xmp=b"", **extra)
    elif form == "gif":
        image.save(out, "GIF")
    elif form == "heic":
        image.save(out, "HEIF", quality=90, exif=None, xmp=None, **extra)
    elif form == "avif":
        image.save(out, "AVIF", quality=90, exif=b"", xmp=b"", **extra)
    else:  # pragma: no cover - every format of kind_of is above
        raise ValueError(form)
    return out.getvalue()


def _redraw_animation(image: Any) -> bytes:
    from PIL import ImageSequence

    frames = []
    for frame in ImageSequence.Iterator(image):
        copy = frame.copy()
        _clean_info(copy)
        frames.append(copy)
    out = io.BytesIO()
    frames[0].save(out, "GIF", save_all=True, append_images=frames[1:], loop=image.info.get("loop", 0),
                   duration=image.info.get("duration", 100), disposal=2)
    return out.getvalue()


# --- Metadata away without encoding again -------------------------------------------------------------------------

#: APP segments a JPEG keeps, by the words they begin with: JFIF, the colour profile, Adobe's colour transform (CMYK
#: needs it). EXIF, XMP, IPTC, MPF (the second pictures of a phone), comments and all others go.
_JPEG_KEPT = {0xE0: (b"JFIF\0", b"JFXX\0"), 0xE2: (b"ICC_PROFILE\0",), 0xEE: (b"Adobe",)}


def strip_jpeg(data: bytes) -> bytes | None:
    """The JPEG without its metadata segments and without anything after its end, the picture's bytes unchanged;
    ``None`` when it does not read as a JPEG."""
    size = len(data)
    if data[:2] != b"\xff\xd8":
        return None
    out = bytearray(b"\xff\xd8")
    at = 2
    while True:
        if at >= size or data[at] != 0xFF:
            return None
        while at < size and data[at] == 0xFF:
            at += 1
        if at >= size:
            return None
        marker = data[at]
        at += 1
        if marker == 0xD9:
            out += b"\xff\xd9"
            return bytes(out)
        if 0xD0 <= marker <= 0xD7 or marker == 0x01:
            out += bytes((0xFF, marker))
            continue
        if at + 2 > size:
            return None
        length = int.from_bytes(data[at: at + 2], "big")
        if length < 2 or at + length > size:
            return None
        body = data[at + 2: at + length]
        if 0xE0 <= marker <= 0xEF:
            keep = any(body.startswith(word) for word in _JPEG_KEPT.get(marker, ()))
        else:
            keep = marker != 0xFE
        if keep:
            out += bytes((0xFF, marker)) + data[at: at + length]
        at += length
        if marker == 0xDA:
            # The picture itself, up to the next marker that is no restart and no stuffed byte.
            start = at
            while True:
                at = data.find(b"\xff", at)
                if at < 0 or at + 1 >= size:
                    return None
                following = data[at + 1]
                if following == 0x00 or 0xD0 <= following <= 0xD7:
                    at += 2
                elif following == 0xFF:
                    at += 1
                else:
                    break
            out += data[start:at]


def _boxes(data: bytes, start: int, end: int) -> Iterator[tuple[bytes, int, int]]:
    """The ISO media boxes between ``start`` and ``end``: type, where the content begins, where the box ends."""
    at = start
    while at + 8 <= end:
        length = int.from_bytes(data[at: at + 4], "big")
        kind = data[at + 4: at + 8]
        head = 8
        if length == 1:
            length = int.from_bytes(data[at + 8: at + 16], "big")
            head = 16
        elif length == 0:
            length = end - at
        if length < head or at + length > end:
            raise ValueError("box")
        yield kind, at + head, at + length
        at += length


def _number(data: bytes, at: int, width: int) -> tuple[int, int]:
    if width not in (0, 2, 4, 8):
        raise ValueError("width")
    return (int.from_bytes(data[at: at + width], "big") if width else 0), at + width


def _text(data: bytes, at: int, end: int) -> tuple[bytes, int]:
    stop = data.index(b"\0", at, end)
    return data[at:stop], stop + 1


def _items(data: bytes, start: int, end: int) -> dict[int, tuple[bytes, bytes]]:
    """``iinf``: every item's type and content type."""
    version = data[start]
    _count, at = _number(data, start + 4, 2 if version == 0 else 4)
    found: dict[int, tuple[bytes, bytes]] = {}
    for kind, begin, stop in _boxes(data, at, end):
        if kind != b"infe":
            continue
        entry = data[begin]
        at = begin + 4
        if entry >= 2:
            item, at = _number(data, at, 2 if entry == 2 else 4)
            item_type = data[at + 2: at + 6]
            _name, at = _text(data, at + 6, stop)
            content = _text(data, at, stop)[0] if item_type == b"mime" else b""
        else:
            item, at = _number(data, at, 2)
            _name, at = _text(data, at + 2, stop)
            item_type, content = b"mime", _text(data, at, stop)[0]
        found[item] = (item_type, content)
    return found


def _locations(data: bytes, start: int) -> dict[int, tuple[int, list[tuple[int, int]]]]:
    """``iloc``: every item's construction method (-1: in another file) and its pieces (offset, length)."""
    version = data[start]
    at = start + 4
    offset_size, length_size = data[at] >> 4, data[at] & 0x0F
    base_size, index_size = data[at + 1] >> 4, (data[at + 1] & 0x0F) if version in (1, 2) else 0
    count, at = _number(data, at + 2, 2 if version < 2 else 4)
    found: dict[int, tuple[int, list[tuple[int, int]]]] = {}
    for _ in range(count):
        item, at = _number(data, at, 2 if version < 2 else 4)
        method = 0
        if version in (1, 2):
            method, at = _number(data, at, 2)
            method &= 0x0F
        reference, at = _number(data, at, 2)
        base, at = _number(data, at, base_size)
        pieces, at = _number(data, at, 2)
        extents = []
        for _ in range(pieces):
            _index, at = _number(data, at, index_size)
            offset, at = _number(data, at, offset_size)
            length, at = _number(data, at, length_size)
            extents.append((base + offset, length))
        found[item] = (method if reference == 0 else -1, extents)
    return found


#: An EXIF item without entries: where the TIFF header begins (0), the header, an empty first directory.
_EMPTY_EXIF = b"\0\0\0\0MM\0*\0\0\0\x08\0\0\0\0\0\0"
_EMPTY_XMP = (b'<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"/>'
              b'<?xpacket end="w"?>')
_XMP_UUID = uuid.UUID("be7acfcb-97a9-42e8-9c71-999491e3afac").bytes


def blank_heif(data: bytes) -> bytes | None:
    """A HEIC or AVIF with its EXIF and XMP overwritten where they lie (an EXIF without entries, an empty XMP packet
    padded with blanks), every picture and every offset unchanged; ``None`` when its boxes do not read."""
    out = bytearray(data)
    try:
        top = list(_boxes(data, 0, len(data)))
        meta = next(((begin, stop) for kind, begin, stop in top if kind == b"meta"), None)
        if meta is None:
            return None
        items: dict[int, tuple[bytes, bytes]] = {}
        locations: dict[int, tuple[int, list[tuple[int, int]]]] = {}
        idat: tuple[int, int] | None = None
        for kind, begin, stop in _boxes(data, meta[0] + 4, meta[1]):
            if kind == b"iinf":
                items = _items(data, begin, stop)
            elif kind == b"iloc":
                locations = _locations(data, begin)
            elif kind == b"idat":
                idat = (begin, stop)
        for item, (item_type, content) in items.items():
            if item_type == b"Exif":
                blank, pad = _EMPTY_EXIF, b"\0"
            elif item_type == b"mime" and (b"xmp" in content.lower() or b"rdf+xml" in content.lower()):
                blank, pad = _EMPTY_XMP, b" "
            else:
                continue
            method, extents = locations.get(item, (-1, []))
            if method == 1 and idat is not None:
                base, limit = idat
            elif method == 0:
                base, limit = 0, len(data)
            else:
                return None
            if not extents or any(length <= 0 for _, length in extents):
                return None
            total = sum(length for _, length in extents)
            fill = blank + pad * (total - len(blank)) if total >= len(blank) else b"\0" * total
            done = 0
            for offset, length in extents:
                if base + offset + length > limit:
                    return None
                out[base + offset: base + offset + length] = fill[done: done + length]
                done += length
        for kind, begin, stop in top:
            if kind == b"uuid" and data[begin: begin + 16] == _XMP_UUID:
                out[begin + 16: stop] = b" " * (stop - begin - 16)
    except (ValueError, IndexError):
        return None
    return bytes(out)


# --- PDFs ---------------------------------------------------------------------------------------------------------


def _pdf(path: Path) -> Prepared:
    import pypdfium2 as pdfium

    found = Prepared(kind=PDF, mime="application/pdf", inline=True)
    try:
        document = pdfium.PdfDocument(str(path))
    except pdfium.PdfiumError:
        # Damaged or locked with a password: still a PDF, shown by the browser if it can.
        return found
    try:
        found.pages = len(document)
        if found.pages:
            page = document[0]
            width, height = page.get_size()
            scale = min(THUMB_EDGE / max(width, height, 1), 4.0)
            bitmap = page.render(scale=scale)
            found.thumb = _webp(bitmap.to_pil(), THUMB_EDGE, 75)
            found.width, found.height = round(width), round(height)
    finally:
        document.close()
    return found


# --- Videos -------------------------------------------------------------------------------------------------------


def tools() -> tuple[str | None, str | None]:
    """ffprobe and ffmpeg where they are (in the image both are), else ``None``."""
    return shutil.which("ffprobe"), shutil.which("ffmpeg")


def _video(path: Path, form: str) -> Prepared:
    mime = {"mp4": "video/mp4", "mov": "video/mp4", "webm": "video/webm"}.get(form, "video/x-matroska")
    # A QuickTime film from an iPhone plays in Chrome given out as MP4; Matroska only to download.
    found = Prepared(kind=VIDEO, mime=mime, inline=form in ("mp4", "mov", "webm"))
    probe, ffmpeg = tools()
    if probe is None:
        return found
    answer = subprocess.run(
        [probe, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", "--", str(path)],
        capture_output=True, timeout=VIDEO_SECONDS, check=False,
    )
    info = json.loads(answer.stdout or b"{}")
    streams = info.get("streams") or []
    video = next((stream for stream in streams if stream.get("codec_type") == "video"
                  and not (stream.get("disposition") or {}).get("attached_pic")), None)
    if video is None:
        # Sound only (an M4A behind a video brand): a file.
        return Prepared(kind=FILE)
    found.width, found.height = video.get("width"), video.get("height")
    try:
        found.duration_ms = round(float((info.get("format") or {}).get("duration") or 0) * 1000) or None
    except ValueError:
        found.duration_ms = None
    if ffmpeg is not None:
        found.thumb = _still(ffmpeg, path, found.duration_ms)
    return found


def _still(ffmpeg: str, path: Path, duration_ms: int | None) -> bytes | None:
    from PIL import Image

    at = "0.5" if not duration_ms or duration_ms > 1500 else "0"
    with tempfile.TemporaryDirectory(prefix="nexnotes-still-") as folder:
        target = Path(folder) / "still.png"
        subprocess.run(
            [ffmpeg, "-v", "error", "-nostdin", "-y", "-threads", "2", "-ss", at, "-i", str(path), "-frames:v", "1",
             "-vf", f"scale='min({THUMB_EDGE * 2},iw)':-2", str(target)],
            capture_output=True, timeout=VIDEO_SECONDS, check=False,
        )
        if not target.is_file():
            return None
        with Image.open(target) as still:
            return _webp(still, THUMB_EDGE, 75)

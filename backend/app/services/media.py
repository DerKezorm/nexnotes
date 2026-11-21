"""What a file is, decided from its content, and what the browser gets to see of it (NOTES-10).

* **The kind comes from the first bytes**, never from the name or the type the browser claims (``kind_of``): a
  picture is one of the formats of the profile pictures (``avatars.sniff``), a PDF begins with ``%PDF-``, a video is an
  ISO media file of a video brand or a WebM/Matroska file and has a video stream. Everything else is a "file": only
  downloaded, never shown in the page (HTML, SVG, XML, programs, office files, archives).
* **A picture is drawn anew** like a profile picture: upright, without EXIF, XMP, place or device; the file kept is the
  new one, in the same format (a BMP as PNG). HEIC stays HEIC, so that the original is there to download (EC-3); a
  WebP of at most ``VIEW_EDGE`` pixels is what every browser shows, a WebP of ``THUMB_EDGE`` the preview.
* **A PDF** gets its number of pages and a picture of its first page (pdfium).
* **A video** gets its length, its size and a picture (ffprobe, ffmpeg; without them the browser shows the first frame
  itself). It is not encoded again.

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
#: Seconds ffprobe and ffmpeg may take for one video.
VIDEO_SECONDS = 30

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
    view: bytes | None = None
    thumb: bytes | None = None
    #: The name's ending changed with the format (a BMP kept as PNG).
    suffix: str | None = None
    notes: list[str] = field(default_factory=list)


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


def prepare(path: Path) -> Prepared:
    """What the file at ``path`` is and what the browser gets of it. Never raises for a broken or hostile file: what
    cannot be read is a file to download."""
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
    except Exception as exc:  # noqa: BLE001 - a hostile file fails in the decoder's own way
        logger.info("An attachment could not be read as %s: %s", kind, type(exc).__name__)
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


def _picture(path: Path, form: str) -> Prepared:
    from PIL import Image, ImageOps

    _heif()
    with Image.open(path) as image:
        if image.width * image.height > MAX_PIXELS:
            return Prepared(kind=FILE, notes=["too many pixels"])
        frames = getattr(image, "n_frames", 1)
        icc = image.info.get("icc_profile")
        if form == "gif" and frames > 1:
            redrawn = _redraw_animation(image)
            first = image.copy().convert("RGBA")
            upright = first
        else:
            upright = ImageOps.exif_transpose(image)
            upright.load()
            redrawn = _redraw(upright, form, icc)
        width, height = upright.size
        view = None
        if form not in SHOWN or max(width, height) > VIEW_EDGE:
            view = _webp(upright, VIEW_EDGE, 82)
        thumb = _webp(upright, THUMB_EDGE, 75)
    return Prepared(kind=IMAGE, mime=IMAGE_TYPES[form], inline=form in SHOWN or form == "bmp", width=width,
                    height=height, redrawn=redrawn, view=view, thumb=thumb,
                    suffix=".png" if form == "bmp" else None)


def _redraw(image: Any, form: str, icc: bytes | None) -> bytes:
    """The picture in its own format again, from its pixels alone (the colour profile kept, nothing else)."""
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

    frames = [frame.copy() for frame in ImageSequence.Iterator(image)]
    out = io.BytesIO()
    frames[0].save(out, "GIF", save_all=True, append_images=frames[1:], loop=image.info.get("loop", 0),
                   duration=image.info.get("duration", 100), disposal=2)
    return out.getvalue()


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
            [ffmpeg, "-v", "error", "-nostdin", "-y", "-ss", at, "-i", str(path), "-frames:v", "1",
             "-vf", f"scale='min({THUMB_EDGE * 2},iw)':-2", str(target)],
            capture_output=True, timeout=VIDEO_SECONDS, check=False,
        )
        if not target.is_file():
            return None
        with Image.open(target) as still:
            return _webp(still, THUMB_EDGE, 75)

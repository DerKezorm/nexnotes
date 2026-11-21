"""The worker of text recognition (NOTES-11): reads the pages of one attachment in a process of its own.

Run as ``python -I app/ocr_worker.py`` by ``services/ocr.py``, one process for a few pages, then it ends (the way of
nexpaper's worker). A broken or hostile file can take only this process down: the server gives it a time limit (it
kills the process when it is reached), a memory limit where the system has one, a folder of its own as its home, and a
lower priority than itself. Nothing from ``app`` is imported: this file stands alone (the standard library, Pillow,
pillow-heif, pypdfium2), and it knows no database, no settings, no secret, only the paths it was given.

Input: one JSON object on standard input. Output: one JSON object on the last line of standard output.

* ``{"op": "recognize", "path", "kind": "pdf"|"image", "pages": [1, 2] | null, "first": n, "languages": ["deu"],
  "tesseract": path | null, "text_out": path, ...}``: the text of the pages asked for (``pages``; ``null`` means the
  first ``first`` pages). A page of a PDF that carries text of its own (``MIN_LAYER_CHARACTERS`` letters and digits)
  is read as it is (``layer``) and Tesseract is not asked; the others are drawn at 300 dpi and read by Tesseract
  (``ocr``), as is a picture. The pages go to ``text_out`` as JSON (``[{page, state, source, text, confidence}]``);
  the answer says how many pages there are: ``{"ok": true, "pages": n, "read": [..], "unavailable": bool}``.
* ``{"op": "render", "path", "page", "width", "out"}``: one page of a PDF drawn as WebP for the large view.

Before it touches a file the worker puts hard limits on itself and on what it starts: ``memory_mb`` of memory and
``cpu_seconds`` of CPU time, as a job object under Windows (everything in it killed with this process) and as
``RLIMIT_AS`` and ``RLIMIT_CPU`` elsewhere. Without them it reads nothing (``unguarded``).

Errors: ``{"ok": false, "error": code, "retry": bool}`` with the codes ``broken`` (not a picture or PDF that can be
read, encrypted), ``too_large`` (past the memory limit), ``unguarded``, ``failed``.
"""

from __future__ import annotations

import contextlib
import json
import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

#: A PDF page with at least this many letters and digits of its own text is read as it is, not recognised (AC-2). A
#: page that carries only a page number or a stamp as text is a scan and is recognised.
MIN_LAYER_CHARACTERS = 30
#: Pages of a PDF are drawn at this resolution for Tesseract.
DPI = 300
#: Pixels of a page or a picture handed to Tesseract at most; larger ones are drawn smaller.
MAX_OCR_PIXELS = 30_000_000
#: Pictures above this are refused (a decompression bomb).
MAX_IMAGE_PIXELS = 120_000_000
#: A picture whose longest edge is shorter than this is drawn twice as large first: Tesseract reads small print badly.
SMALL_EDGE = 1200
#: Words Tesseract is less sure of than this (0 to 100) are left out: the scratches of a photo it reads as letters.
MIN_WORD_CONFIDENCE = 60
#: A page keeps its text only with at least this many letters and digits in sure words and this mean confidence;
#: otherwise it is a page without text (a holiday photo, EC-3).
MIN_PAGE_CHARACTERS = 8
MIN_PAGE_CONFIDENCE = 70
#: Characters of text kept per page.
MAX_PAGE_CHARS = 100_000
#: The languages the image carries (Tesseract's codes); nothing else is asked for.
LANGUAGES = ("deu", "eng", "fra", "spa", "ita", "nld", "por", "pol", "tur")


class Refused(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


#: Kept open for the life of the process: when it closes (the process ends), whatever is still in the job is killed.
_JOB: Any = None


def _limit_windows(megabytes: int, seconds: int) -> bool:
    """A job object around this process and all it starts (Tesseract): at most ``megabytes`` of memory together, at
    most ``seconds`` of CPU each, and everything killed when this process ends."""
    global _JOB
    import ctypes
    from ctypes import wintypes

    class Basic(ctypes.Structure):
        _fields_ = [("PerProcessUserTimeLimit", ctypes.c_longlong), ("PerJobUserTimeLimit", ctypes.c_longlong),
                    ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                    ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                    ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD),
                    ("SchedulingClass", wintypes.DWORD)]

    class Counters(ctypes.Structure):
        _fields_ = [(name, ctypes.c_ulonglong) for name in ("Reads", "Writes", "Others", "ReadBytes", "WriteBytes",
                                                           "OtherBytes")]

    class Extended(ctypes.Structure):
        _fields_ = [("Basic", Basic), ("Io", Counters), ("ProcessMemoryLimit", ctypes.c_size_t),
                    ("JobMemoryLimit", ctypes.c_size_t), ("PeakProcessMemoryUsed", ctypes.c_size_t),
                    ("PeakJobMemoryUsed", ctypes.c_size_t)]

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateJobObjectW.restype = wintypes.HANDLE
    kernel32.GetCurrentProcess.restype = wintypes.HANDLE
    kernel32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    job = kernel32.CreateJobObjectW(None, None)
    if not job:
        return False
    limits = Extended()
    # Process time, process memory, job memory, kill on close.
    limits.Basic.LimitFlags = 0x0002 | 0x0100 | 0x0200 | 0x2000
    limits.Basic.PerProcessUserTimeLimit = seconds * 10_000_000
    limits.ProcessMemoryLimit = limits.JobMemoryLimit = megabytes * 1024 * 1024
    if not kernel32.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
        return False
    if not kernel32.AssignProcessToJobObject(job, kernel32.GetCurrentProcess()):
        return False
    _JOB = job
    return True


def _limit(megabytes: int, seconds: int) -> bool:
    """Hard limits before any file is touched: memory and CPU time, for this process and Tesseract. Without them the
    worker reads nothing (``unguarded``)."""
    if megabytes <= 0 or seconds <= 0:
        return False
    if os.name == "nt":
        return _limit_windows(megabytes, seconds)
    try:
        import resource
    except ImportError:
        return False
    size = megabytes * 1024 * 1024
    try:
        resource.setrlimit(resource.RLIMIT_AS, (size, size))
        resource.setrlimit(resource.RLIMIT_CPU, (seconds, seconds + 5))
    except (ValueError, OSError):
        return False
    return True


def _lower_priority() -> None:
    """Below the server: writing stays fluid while pages are read (EC-1). Tesseract inherits it."""
    with contextlib.suppress(AttributeError, OSError):
        os.nice(10)


def _stop_with_the_parent() -> None:
    """The server went away (killed, restarted): this process ends too instead of working on for nobody."""
    parent = os.getppid()

    def watch() -> None:
        while True:
            time.sleep(2)
            if os.getppid() != parent:
                os._exit(3)

    threading.Thread(target=watch, daemon=True).start()


# --- Reading Tesseract's answer ---------------------------------------------------------------------------------------


def text_from_tsv(tsv: str) -> tuple[str, float, int]:
    """The text of a page from Tesseract's TSV: only words it is sure of (``MIN_WORD_CONFIDENCE``), in their lines and
    paragraphs. Returns the text, the mean confidence of the words kept and their letters and digits."""
    lines: dict[tuple[int, int, int], list[str]] = {}
    order: list[tuple[int, int, int]] = []
    confidences: list[float] = []
    characters = 0
    for row in tsv.splitlines()[1:]:
        parts = row.split("\t")
        if len(parts) < 12 or parts[0] != "5":
            continue
        word = parts[11].strip()
        try:
            confidence = float(parts[10])
        except ValueError:
            continue
        if not word or confidence < MIN_WORD_CONFIDENCE:
            continue
        alnum = sum(1 for char in word if char.isalnum())
        if alnum == 0:
            continue
        key = (int(parts[2]), int(parts[3]), int(parts[4]))
        if key not in lines:
            lines[key] = []
            order.append(key)
        lines[key].append(word)
        confidences.append(confidence)
        characters += alnum
    out: list[str] = []
    paragraph: tuple[int, int] | None = None
    for key in order:
        if paragraph is not None and key[:2] != paragraph:
            out.append("")
        paragraph = key[:2]
        out.append(" ".join(lines[key]))
    mean = sum(confidences) / len(confidences) if confidences else 0.0
    return "\n".join(out).strip(), mean, characters


def worth_keeping(text: str, confidence: float, characters: int) -> bool:
    """Whether a page read by Tesseract has text, or only what it made of a picture's shapes (EC-3)."""
    return bool(text) and characters >= MIN_PAGE_CHARACTERS and confidence >= MIN_PAGE_CONFIDENCE


def _has_layer(value: str) -> bool:
    return sum(1 for char in value if char.isalnum()) >= MIN_LAYER_CHARACTERS


def _clean(value: str) -> str:
    value = value.replace("\r\n", "\n").replace("\r", "\n").replace("\f", "\n").replace("\x00", "")
    return value.strip()[:MAX_PAGE_CHARS]


# --- Tesseract --------------------------------------------------------------------------------------------------------


class Unavailable(Exception):
    """No Tesseract here."""


def _tesseract(binary: str | None, picture: Path, languages: list[str], seconds: float, dpi: int | None) -> str:
    """Tesseract's TSV for one picture; ``Unavailable`` without Tesseract, ``TimeoutError`` past ``seconds``."""
    found = binary or shutil.which("tesseract")
    if not found:
        raise Unavailable
    command = [found, str(picture), "stdout", "-l", "+".join(languages), "--psm", "3"]
    if dpi:
        command += ["--dpi", str(dpi)]
    command.append("tsv")
    try:
        done = subprocess.run(command, capture_output=True, timeout=seconds, check=False)
    except subprocess.TimeoutExpired as exc:
        raise TimeoutError from exc
    except OSError as exc:
        raise Unavailable from exc
    if done.returncode != 0:
        raise RuntimeError(done.stderr.decode("utf-8", "replace").strip().splitlines()[-1:] or "tesseract")
    return done.stdout.decode("utf-8", "replace")


def _pillow() -> Any:
    import PIL.Image
    import pillow_heif

    pillow_heif.register_heif_opener()
    PIL.Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS
    return PIL.Image


def _for_tesseract(image: Any, target: Path) -> None:
    """A picture as Tesseract reads it best: grey, not too small, not too large."""
    pil = _pillow()
    image = image.convert("L")
    width, height = image.size
    if max(width, height) < SMALL_EDGE:
        image = image.resize((width * 2, height * 2), pil.Resampling.LANCZOS)
    elif width * height > MAX_OCR_PIXELS:
        factor = (MAX_OCR_PIXELS / (width * height)) ** 0.5
        image = image.resize((max(1, int(width * factor)), max(1, int(height * factor))), pil.Resampling.LANCZOS)
    image.save(target, "PNG")


def _read(binary: str | None, picture: Path, languages: list[str], seconds: float,
          dpi: int | None) -> dict[str, Any]:
    try:
        tsv = _tesseract(binary, picture, languages, seconds, dpi)
    except TimeoutError:
        return {"state": "failed", "source": "ocr", "text": "", "error": "timeout"}
    except RuntimeError:
        return {"state": "failed", "source": "ocr", "text": "", "error": "failed"}
    text, confidence, characters = text_from_tsv(tsv)
    if not worth_keeping(text, confidence, characters):
        return {"state": "empty", "source": "ocr", "text": "", "confidence": round(confidence, 1)}
    return {"state": "done", "source": "ocr", "text": _clean(text), "confidence": round(confidence, 1)}


# --- The operations ---------------------------------------------------------------------------------------------------


def _open_pdf(path: Path) -> Any:
    import pypdfium2 as pdfium

    try:
        return pdfium.PdfDocument(str(path))
    except Exception as exc:  # pdfium names a broken file and a password the same way here
        raise Refused("broken") from exc


def _layer_text(page: Any) -> str:
    textpage = page.get_textpage()
    try:
        return textpage.get_text_bounded() or ""
    finally:
        textpage.close()


def _wanted(request: dict[str, Any], total: int) -> list[int]:
    pages = request.get("pages")
    if pages is None:
        first = int(request.get("first") or 1)
        return list(range(1, min(total, first) + 1))
    return [int(page) for page in pages if 1 <= int(page) <= total]


def recognize(request: dict[str, Any]) -> dict[str, Any]:
    source = Path(request["path"])
    languages = [code for code in request.get("languages") or [] if code in LANGUAGES] or ["deu", "eng"]
    seconds = float(request.get("page_seconds") or 120)
    binary = request.get("tesseract")
    work = Path.cwd()
    results: list[dict[str, Any]] = []
    unavailable = False
    if request.get("kind") == "pdf":
        document = _open_pdf(source)
        try:
            total = len(document)
            for number in _wanted(request, total):
                page = document[number - 1]
                try:
                    own = _layer_text(page)
                    if _has_layer(own):
                        results.append({"page": number, "state": "done", "source": "layer", "text": _clean(own)})
                        continue
                    if unavailable:
                        results.append({"page": number, "state": "unavailable", "source": "", "text": ""})
                        continue
                    width, height = page.get_size()
                    scale = DPI / 72
                    if width * height * scale * scale > MAX_OCR_PIXELS:
                        scale = (MAX_OCR_PIXELS / (width * height)) ** 0.5
                    bitmap = page.render(scale=scale, grayscale=True)
                    picture = work / f"page-{number}.png"
                    bitmap.to_pil().save(picture, "PNG")
                    bitmap.close()
                finally:
                    page.close()
                try:
                    found = _read(binary, picture, languages, seconds, int(scale * 72))
                except Unavailable:
                    unavailable = True
                    found = {"state": "unavailable", "source": "", "text": ""}
                finally:
                    with contextlib.suppress(OSError):
                        picture.unlink()
                results.append({"page": number, **found})
        finally:
            document.close()
    else:
        pil = _pillow()
        try:
            image = pil.open(source)
            image.load()
        except pil.DecompressionBombError as exc:
            raise Refused("too_large") from exc
        except Exception as exc:  # whatever Pillow says, the picture cannot be read
            raise Refused("broken") from exc
        total = 1
        if _wanted(request, total):
            picture = work / "picture.png"
            _for_tesseract(image, picture)
            try:
                found = _read(binary, picture, languages, seconds, None)
            except Unavailable:
                unavailable = True
                found = {"state": "unavailable", "source": "", "text": ""}
            results.append({"page": 1, **found})
    Path(request["text_out"]).write_text(json.dumps(results, ensure_ascii=False), encoding="utf-8")
    return {"ok": True, "pages": total, "read": [entry["page"] for entry in results], "unavailable": unavailable}


def render(request: dict[str, Any]) -> dict[str, Any]:
    document = _open_pdf(Path(request["path"]))
    try:
        number = int(request.get("page") or 1)
        if not 1 <= number <= len(document):
            raise Refused("not_found")
        page = document[number - 1]
        try:
            width = min(max(int(request.get("width") or 1400), 200), 2400)
            scale = width / max(page.get_width(), 1)
            if page.get_width() * page.get_height() * scale * scale > MAX_OCR_PIXELS:
                scale = (MAX_OCR_PIXELS / (page.get_width() * page.get_height())) ** 0.5
            bitmap = page.render(scale=scale)
            bitmap.to_pil().convert("RGB").save(request["out"], "WEBP", quality=80)
            bitmap.close()
        finally:
            page.close()
    finally:
        document.close()
    return {"ok": True}


def probe(request: dict[str, Any]) -> dict[str, Any]:
    """Takes ``megabytes`` of memory and touches it: shows that the limits hold (the tests)."""
    taken = bytearray(int(request.get("megabytes") or 1) * 1024 * 1024)
    for index in range(0, len(taken), 4096):
        taken[index] = 1
    return {"ok": True, "taken": len(taken)}


def main() -> int:
    real_out = sys.stdout
    sys.stdout = sys.stderr  # a library that prints must not break the answer
    try:
        request = json.loads(sys.stdin.read(65536))
        _stop_with_the_parent()
        # Tesseract uses one thread, the allocator keeps few arenas: one attachment never floods the machine.
        os.environ["OMP_THREAD_LIMIT"] = "1"
        os.environ.setdefault("MALLOC_ARENA_MAX", "2")
        _lower_priority()
        if not _limit(int(request.get("memory_mb") or 0), int(request.get("cpu_seconds") or 0)):
            raise Refused("unguarded")
        operations = {"recognize": recognize, "render": render, "probe": probe}
        op = request.get("op")
        result = operations[op](request) if op in operations else {"ok": False, "error": "failed", "retry": False}
    except Refused as exc:
        result = {"ok": False, "error": exc.code, "retry": False}
    except MemoryError:
        result = {"ok": False, "error": "too_large", "retry": False}
    except Exception as exc:  # noqa: BLE001 - never a traceback with paths in the answer
        print(f"worker failed: {type(exc).__name__}", file=sys.stderr)
        result = {"ok": False, "error": "failed", "retry": True}
    real_out.write("\n" + json.dumps(result) + "\n")
    real_out.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())

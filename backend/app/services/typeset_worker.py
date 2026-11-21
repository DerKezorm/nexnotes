"""Typst in a process of its own: what the export hands it is set there, and a set that runs too long is stopped from
outside. Imports nothing of the app, so a fresh process starts quickly (Windows spawns, it does not fork).

**Nothing from the net.** Typst fetches a package (``#import "@preview/…"``) from packages.typst.org when it is not in
its package folders. Here both folders are an empty one of the set, and the process sends whatever it would fetch to
``OFFLINE_PROXY``, a port where nothing listens: an import of a package fails, nothing leaves the server.
"""

from __future__ import annotations

import multiprocessing
import os
from multiprocessing.connection import Connection
from pathlib import Path

#: How long one set may take before the process is stopped.
TIMEOUT_SECONDS = 90
#: Where the typesetting process sends anything it would fetch from the net: port 9 refuses at once.
OFFLINE_PROXY = "http://127.0.0.1:9"
_PROXY_VARIABLES = ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy")
_NO_PROXY_VARIABLES = ("NO_PROXY", "no_proxy")


class TypesetFailed(Exception):
    """Typst refused the source or ran out of time; ``reason`` says which (``timeout``, ``typst``)."""

    def __init__(self, reason: str, detail: str = "") -> None:
        super().__init__(detail or reason)
        self.reason = reason
        self.detail = detail


def compile_here(main: Path, *, fonts: Path, packages: Path, fmt: str, ppi: float) -> bytes | list[bytes]:
    """Set ``main`` in this process. The root is the folder of ``main``: Typst reads nothing outside it, and no font
    of the machine, only nexnotes' own (``app/fonts``). ``packages`` serves as the folder of local packages and as the
    cache of fetched ones: an empty folder, so no package is there."""
    import typst

    try:
        output = typst.compile(
            str(main), root=str(main.parent), font_paths=[str(fonts)], ignore_system_fonts=True,
            package_path=str(packages), package_cache_path=str(packages), format=fmt, ppi=ppi,
        )
    except Exception as exc:  # Typst raises its own error with the line it stumbled over
        raise TypesetFailed("typst", str(exc)[:2000]) from exc
    return output


def offline(proxy: str) -> None:
    """This process fetches nothing: every request Typst would make goes to ``proxy``, none passes by it."""
    for name in _PROXY_VARIABLES:
        os.environ[name] = proxy
    for name in _NO_PROXY_VARIABLES:
        os.environ.pop(name, None)


def _child(conn: Connection, main: str, fonts: str, packages: str, fmt: str, ppi: float, proxy: str) -> None:
    try:
        offline(proxy)
        conn.send(("ok", compile_here(Path(main), fonts=Path(fonts), packages=Path(packages), fmt=fmt, ppi=ppi)))
    except TypesetFailed as exc:
        conn.send(("failed", exc.detail))
    except BaseException as exc:  # noqa: BLE001 -- anything else still ends the wait of the parent
        conn.send(("failed", type(exc).__name__))
    finally:
        conn.close()


def compile_apart(
    main: Path, *, fonts: Path, packages: Path, fmt: str, ppi: float, timeout: float = TIMEOUT_SECONDS
) -> bytes | list[bytes]:
    """Set ``main`` in a process of its own and wait at most ``timeout`` seconds for it."""
    context = multiprocessing.get_context("spawn")
    receive, send = context.Pipe(duplex=False)
    process = context.Process(
        target=_child, args=(send, str(main), str(fonts), str(packages), fmt, ppi, OFFLINE_PROXY), daemon=True
    )
    process.start()
    send.close()
    try:
        if not receive.poll(timeout):
            raise TypesetFailed("timeout")
        try:
            status, value = receive.recv()
        except EOFError as exc:
            raise TypesetFailed("typst", "the typesetting process ended without an answer") from exc
    finally:
        receive.close()
        if process.is_alive():
            process.kill()
        process.join(5)
    if status != "ok":
        raise TypesetFailed("typst", str(value))
    return value  # type: ignore[no-any-return]

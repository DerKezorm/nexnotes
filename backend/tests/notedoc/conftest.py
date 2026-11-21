"""Tests of the note document and the live room, without the app around them."""

from __future__ import annotations

import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
for path in (str(BACKEND), str(HERE)):
    if path not in sys.path:
        sys.path.insert(0, path)

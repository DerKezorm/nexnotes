"""The operator's own languages: JSON files in ``<data_dir>/locales`` (``NEXNOTES_LOCALES_DIR``), from the shared
module sprachen 1.0.0 (E51). nexnotes was its model, so every name of before stands here unchanged (``available``,
``load``, ``valid_code``, ``save``, ``remove``, ``forget``, ``locales_dir``, ``LocaleError`` …); the routes under
``/api/locales`` are the module's (``main.py``), the same ways and answers as before, the list now with the built-in
languages and ``built_in``, ``own``.

German and English ship inside the frontend; a file for one of them lays its texts over the shipped ones. The page
makes the template itself (it knows the English texts), so the server has none.
"""

from __future__ import annotations

from pathlib import Path

from ..config import get_settings
from ..vendor import nexsprachen
from ..vendor.nexsprachen import *

#: The languages nexnotes ships, in the order of its menus.
BUILT_IN = {"de": "Deutsch", "en": "English"}


def _folder() -> Path:
    directory = get_settings().locales_dir
    if directory is None:  # the settings validator fills it; this only satisfies the type
        raise RuntimeError("locales_dir is not set")
    return directory


nexsprachen.configure(nexsprachen.AppConfig(app_name="nexnotes", folder=_folder, built_in=BUILT_IN))

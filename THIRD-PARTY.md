# Third-party software

nexnotes itself is under the AGPL-3.0 (`LICENSE`). This lists what it brings along from others and that is not
fetched by the package managers alone: files that lie in this repository or go into the image as they are.

| What | Where | Authors | Licence | Text |
|---|---|---|---|---|
| Inter (variable, upright and italic), the font of PDFs | `backend/app/fonts/Inter*.ttf` | The Inter Project Authors | OFL-1.1 | `backend/app/fonts/OFL-inter.txt` |
| JetBrains Mono, code in PDFs | `backend/app/fonts/JetBrainsMono.ttf` | The JetBrains Mono Project Authors | OFL-1.1 | `backend/app/fonts/OFL-jetbrainsmono.txt` |
| Noto Emoji, emoji in PDFs | `backend/app/fonts/NotoEmoji.ttf` | Google LLC | OFL-1.1 | `backend/app/fonts/OFL-notoemoji.txt` |
| Lucide icons, the symbols of notes drawn into PDFs (SVG, written from `lucide-react`) | `backend/app/export_icons.json` | Lucide Contributors, Cole Bemis (Feather) | ISC | `frontend/public/licenses/lucide.txt` |
| Inter for the interface (`@fontsource-variable/inter`) | in the built frontend | The Inter Project Authors | OFL-1.1 | `frontend/public/licenses/fonts.txt` |
| SQLite 3.54.1, the database, built from sqlite.org's source by `docker/sqlite.sh` (instead of Debian's older library) | `/usr/local/lib/libsqlite3.so.0` in the image | The SQLite developers (sqlite.org) | Public Domain | none needed, see https://sqlite.org/copyright.html |
| Swagger UI, the page of the API description at `/api/v1/docs` (`swagger-ui-dist`) | `api-docs/` in the built frontend | SmartBear Software | Apache-2.0 | `api-docs/LICENSE`, `api-docs/NOTICE` beside it |

## Python packages with a binary inside

| Package | What it does here | Licence |
|---|---|---|
| typst 0.15.0 | sets the PDF of a note (Python binding of Typst, which it bundles) | Apache-2.0 |
| pypdf (tests only, not in the image) | reads the text of the PDFs in the tests | BSD-3-Clause |
| pypdfium2 | draws the pages of an attached PDF as pictures (bundles PDFium) | Apache-2.0 or BSD-3-Clause; PDFium BSD-3-Clause |
| pycrdt | the server side of a note edited together (Rust binding of Yrs) | MIT |
| Pillow | reads and makes pictures | MIT-CMU |
| pillow-heif | reads HEIC photos from iPhones; BSD-3-Clause for its own code, the binary wheels are **GPLv2** as a whole, see below | BSD-3-Clause / GPL-2.0 |

### HEIC photos: pillow-heif and the libraries it brings

Its binary wheels, and so the container image, contain:

| Library | Licence |
|---|---|
| libheif | LGPL-3.0 |
| libde265 | LGPL-3.0 |
| x265 | GPL-2.0-or-later |

The wheel ships these notices in `pillow_heif-*.dist-info/licenses/`. GPL-2.0-or-later and LGPL-3.0 may be combined
with an AGPL-3.0 work, and the source of every part is public.

## Python packages added by features

| Package | What it does here | Licence |
|---|---|---|
| http-ece 1.2.1 | encrypts a notification for one browser (Web Push, RFC 8291, aes128gcm; NOTES-14) | MIT |
| tzdata 2026.6 | the time zones by name, so that "today" and "last 7 days" of a smart folder count in the device's zone (NOTES-7) | Apache-2.0 |

## Programs in the image

| Program | What it does here | Licence |
|---|---|---|
| Tesseract (Debian `tesseract-ocr`) with the language data `deu`, `eng`, `fra`, `spa`, `ita`, `nld`, `por`, `pol`, `tur` and `osd` (`tesseract-ocr-*`) | reads the text of attached pictures, scans and PDFs | Apache-2.0 |
| Leptonica (Debian `libleptonica6`, through Tesseract) | reads pictures for Tesseract | BSD-2-Clause |
| FFmpeg (Debian `ffmpeg`, with ffprobe) | the length and a still picture of an attached video | LGPL-2.1-or-later and GPL-2.0-or-later (Debian's build) |
| gosu (Debian `gosu`) | drops root at the start, so nexnotes runs as `PUID`/`PGID` | Apache-2.0 |
| curl (Debian `curl`) | the container's health check | curl (MIT-style) |

The other dependencies are listed in `backend/requirements.txt` and `frontend/package.json` and come with their own
licence files; the About page names the main ones.

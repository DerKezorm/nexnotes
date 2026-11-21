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

## Python packages with a binary inside

| Package | What it does here | Licence |
|---|---|---|
| typst 0.15.0 | sets the PDF of a note (Python binding of Typst, which it bundles) | Apache-2.0 |
| pypdf (tests only, not in the image) | reads the text of the PDFs in the tests | BSD-3-Clause |

## Python packages added by features

| Package | What it does here | Licence |
|---|---|---|
| http-ece 1.2.1 | encrypts a notification for one browser (Web Push, RFC 8291, aes128gcm; NOTES-14) | MIT |

## Programs in the image

| Program | What it does here | Licence |
|---|---|---|
| Tesseract (Debian `tesseract-ocr`) with the language data `deu`, `eng`, `fra`, `spa`, `ita`, `nld`, `por`, `pol`, `tur` and `osd` (`tesseract-ocr-*`) | reads the text of attached pictures, scans and PDFs | Apache-2.0 |
| Leptonica (Debian `libleptonica6`, through Tesseract) | reads pictures for Tesseract | BSD-2-Clause |

The other dependencies are listed in `backend/requirements.txt` and `frontend/package.json` and come with their own
licence files; the About page names the main ones.

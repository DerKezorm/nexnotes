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

The other dependencies are listed in `backend/requirements.txt` and `frontend/package.json` and come with their own
licence files; the About page names the main ones.

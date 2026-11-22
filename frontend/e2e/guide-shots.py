"""Pictures for the guide's screenshots (NOTES-26), with Pillow from the backend's environment.

    python guide-shots.py samples <folder>        made-up pictures for the example notes (a photo, a receipt, a PDF)
    python guide-shots.py webp <png folder> <out> the screenshots as WebP, as small as they still read well

Called by ``guide-shots.mjs``; nothing here reads or writes anything else.
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

FONTS = Path(__file__).resolve().parents[2] / "backend" / "app" / "fonts"


def _font(size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(FONTS / "Inter.ttf"), size)


def _pancakes(path: Path) -> None:
    """A plate of pancakes with berries on a wooden table, drawn."""
    width, height = 1200, 800
    image = Image.new("RGB", (width, height), (176, 124, 82))
    draw = ImageDraw.Draw(image)
    for row in range(0, height, 46):
        shade = 150 + (row // 46 % 3) * 14
        draw.rectangle([0, row, width, row + 44], fill=(shade + 20, shade - 25, shade - 70))
    draw.ellipse([250, 120, 950, 720], fill=(240, 238, 232))
    draw.ellipse([300, 170, 900, 670], fill=(250, 249, 245))
    for layer in range(6):
        top = 420 - layer * 34
        draw.ellipse([360, top - 60, 840, top + 80], fill=(214 - layer * 4, 150 - layer * 3, 70),
                     outline=(170, 110, 50))
    draw.ellipse([420, 170, 780, 290], fill=(232, 178, 92))
    for x, y in [(520, 200), (580, 225), (640, 205), (600, 180), (690, 235), (550, 250)]:
        draw.ellipse([x - 22, y - 22, x + 22, y + 22], fill=(78, 48, 120))
        draw.ellipse([x - 8, y - 14, x + 2, y - 6], fill=(140, 110, 190))
    for x, y in [(470, 230), (730, 210)]:
        draw.ellipse([x - 20, y - 26, x + 20, y + 20], fill=(206, 40, 60))
    image = image.filter(ImageFilter.GaussianBlur(1.2))
    image.save(path, "JPEG", quality=86)


def _lake(path: Path) -> None:
    """A lake in the mountains at dusk, drawn."""
    width, height = 1200, 800
    image = Image.new("RGB", (width, height))
    draw = ImageDraw.Draw(image)
    for y in range(height):
        t = y / height
        draw.line([(0, y), (width, y)], fill=(int(250 - 120 * t), int(190 - 60 * t), int(140 + 60 * t)))
    draw.ellipse([760, 180, 880, 300], fill=(255, 226, 160))
    for base, colour, peaks in [(520, (96, 92, 130), [(0, 520), (180, 300), (360, 470), (560, 260), (780, 450),
                                                     (980, 280), (1200, 480)]),
                                (560, (70, 74, 104), [(0, 560), (240, 400), (420, 520), (700, 380), (900, 540),
                                                     (1200, 420)])]:
        draw.polygon([*peaks, (1200, base + 40), (0, base + 40)], fill=colour)
    for y in range(560, height):
        t = (y - 560) / (height - 560)
        draw.line([(0, y), (width, y)], fill=(int(120 - 60 * t), int(140 - 50 * t), int(180 - 40 * t)))
    for i in range(14):
        y = 600 + i * 14
        draw.line([(800 - i * 12, y), (840 + i * 12, y)], fill=(255, 214, 150), width=2)
    image.save(path, "JPEG", quality=86)


def _receipt(path: Path, language: str) -> None:
    """A shop's receipt, photographed on a table."""
    image = Image.new("RGB", (900, 1200), (88, 96, 108))
    paper = Image.new("RGB", (560, 1000), (250, 250, 246))
    draw = ImageDraw.Draw(paper)
    lines = {
        "de": ["BIOLADEN AM MARKT", "Hauptstraße 12", "", "Äpfel 1 kg        3,20", "Vollkornbrot      4,10",
               "Kaffee            7,90", "Hafermilch        2,10", "Blumen            6,50", "",
               "SUMME            23,80",
               "Bar              25,00", "Rückgeld          1,20", "", "Danke für Ihren Einkauf!"],
        "en": ["ORGANIC GROCER", "12 Market Street", "", "Apples 1 kg       3.20", "Wholemeal bread   4.10",
               "Coffee            7.90", "Oat milk          2.10", "Flowers           6.50", "",
               "TOTAL            23.80",
               "Cash             25.00", "Change            1.20", "", "Thank you for shopping!"],
    }[language]
    font = _font(30)
    for number, line in enumerate(lines):
        draw.text((40, 50 + number * 62), line, fill=(30, 30, 34), font=font)
    paper = paper.rotate(-4, expand=True, fillcolor=(88, 96, 108))
    image.paste(paper, (150, 90))
    image.save(path, "JPEG", quality=88)


def _pdf(path: Path, language: str) -> None:
    """A two-page travel plan as a PDF."""
    pages = []
    titles = {"de": ("Reiseplan Gardasee", ["Tag 1: Anreise über den Brenner", "Tag 2: Malcesine und Monte Baldo",
                                             "Tag 3: Bootsfahrt nach Limone", "Tag 4: Wandern bei Riva"]),
              "en": ("Lake Garda travel plan", ["Day 1: Over the Brenner pass", "Day 2: Malcesine and Monte Baldo",
                                                 "Day 3: Boat trip to Limone", "Day 4: Hiking near Riva"])}[language]
    for page in range(2):
        sheet = Image.new("RGB", (1240, 1754), "white")
        draw = ImageDraw.Draw(sheet)
        draw.rectangle([0, 0, 1240, 220], fill=(56, 189, 248))
        draw.text((90, 70), titles[0], fill="white", font=_font(64))
        for number, line in enumerate(titles[1][page * 2: page * 2 + 2]):
            draw.text((90, 320 + number * 420), line, fill=(30, 30, 34), font=_font(44))
            for row in range(5):
                y = 420 + number * 420 + row * 52
                draw.line([(90, y), (1100 - (row % 2) * 180, y)], fill=(200, 200, 206), width=10)
        pages.append(sheet)
    pages[0].save(path, "PDF", save_all=True, append_images=pages[1:], resolution=150)


def samples(folder: Path) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    _pancakes(folder / "pancakes.jpg")
    _lake(folder / "lake.jpg")
    for language in ("de", "en"):
        _receipt(folder / f"receipt-{language}.jpg", language)
        _pdf(folder / f"plan-{language}.pdf", language)


def webp(source: Path, target: Path) -> None:
    """Every PNG as WebP: lossy, at the quality where the interface's text still reads crisp."""
    target.mkdir(parents=True, exist_ok=True)
    sizes = {}
    for png in sorted(source.glob("*.png")):
        with Image.open(png) as image:
            picture = image.convert("RGB")
            if picture.width > 1280:
                picture = picture.resize((1280, math.ceil(picture.height * 1280 / picture.width)), Image.LANCZOS)
            out = target / (png.stem + ".webp")
            picture.save(out, "WEBP", quality=72, method=6)
            sizes[out.name] = out.stat().st_size
    print(json.dumps({"files": len(sizes), "bytes": sum(sizes.values())}))


if __name__ == "__main__":
    if sys.argv[1] == "samples":
        samples(Path(sys.argv[2]))
    elif sys.argv[1] == "webp":
        webp(Path(sys.argv[2]), Path(sys.argv[3]))
    else:
        raise SystemExit("samples <folder> | webp <png folder> <out>")

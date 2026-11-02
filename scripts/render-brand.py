"""Regenerate outlined brand SVGs. Requires fonttools and brotli."""
from pathlib import Path
from html import escape
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
fonts = {
    weight: TTFont(ASSETS / f"fonts/ibm-plex-sans-latin-{weight}-normal.woff2")
    for weight in (400, 600)
}


def text(value, x, y, size=20, weight=400, color="#F6F5F1"):
    font = fonts[weight]
    glyphs = font.getGlyphSet()
    cmap = font.getBestCmap()
    scale = size / font["head"].unitsPerEm
    offset = 0
    paths = []
    for char in value:
        name = cmap[ord(char)]
        pen = SVGPathPen(glyphs)
        glyphs[name].draw(pen)
        paths.append(f'<path transform="translate({offset},0)" d="{pen.getCommands()}"/>')
        offset += font["hmtx"].metrics[name][0]
    return f'<g aria-label="{escape(value)}" fill="{color}" transform="translate({x},{y}) scale({scale},-{scale})">' + "".join(paths) + "</g>"


def image(height, social=False):
    logo = (ASSETS / "leash-lockup-on-dark.svg").read_text()
    logo = logo[logo.index("<svg"):]
    logo = logo.replace('width="632" height="192"', 'width="221.2" height="67.2"')
    logo = logo.replace('<svg ', '<svg x="64" y="48" ', 1)
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="{height}" viewBox="0 0 1280 {height}" role="img"><title>Leash: The circuit breaker for coding agents.</title>', '<rect width="1280" height="100%" fill="#1A1A17"/>', logo]
    parts.append(text("The circuit breaker for coding agents.", 64, 240 if social else 172, 44, 600))
    parts.append(text("Claude Code. Codex. Cursor.", 64, 286 if social else 220, 22))
    if social:
        parts.extend(['<rect x="64" y="350" width="1152" height="164" rx="4" fill="#F6F5F1"/>', text("PreToolUse", 92, 394, 18, 600, "#4A4843"), text("Permission denied", 92, 438, 28, 600, "#B42318"), text("The workspace kill switch is on.", 92, 476, 20, 400, "#1A1A17"), text("useleash.dev", 64, 576, 20)])
    else:
        parts.append(text("Local usage. Shared budgets. One clear stop.", 64, 258, 18))
    parts.extend([f'<path d="M64 {height-24}H1216" stroke="#F2A900" stroke-width="2"/>', '</svg>'])
    return "\n".join(parts) + "\n"


(ASSETS / "banner.svg").write_text(image(320))
(ASSETS / "social-preview.svg").write_text(image(640, True))

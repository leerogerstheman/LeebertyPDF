#!/usr/bin/env python3
"""LeebertyPDF icon: a gothic capital "L" on a deep blue field.

Generates assets/icon-*.png at several sizes plus a multi-resolution
assets/icon.ico for Windows shortcuts, the taskbar and the installer.

    python tools/make_icon.py
"""
import os
import sys
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "assets")
os.makedirs(ASSETS, exist_ok=True)

# deep blue field, subtly lit from the top-left
NAVY_TOP = (11, 34, 66)
NAVY_BOTTOM = (5, 17, 38)
INK = (245, 248, 253)
INK_EDGE = (198, 216, 240)

# gothic / blackletter faces, best first
FONT_CANDIDATES = [
    r"C:\Windows\Fonts\OLDENGL.TTF",      # Old English Text MT
    r"C:\Windows\Fonts\constan.ttf",      # Constantia (fallback shape)
    r"C:\Windows\Fonts\GOTHIC.TTF",       # Century Gothic (geometric, not gothic)
    r"C:\Windows\Fonts\georgia.ttf",
    r"C:\Windows\Fonts\times.ttf",
    r"C:\Windows\Fonts\segoeui.ttf",
]


def pick_font(size):
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size), path
            except OSError:
                continue
    return ImageFont.load_default(), "default"


def background(size):
    """Vertical gradient plus a soft radial highlight."""
    img = Image.new("RGB", (size, size), NAVY_BOTTOM)
    d = ImageDraw.Draw(img)
    for y in range(size):
        t = y / max(1, size - 1)
        # ease the gradient so the light stays near the top
        e = t ** 0.75
        d.line(
            [(0, y), (size, y)],
            fill=(
                int(NAVY_TOP[0] + (NAVY_BOTTOM[0] - NAVY_TOP[0]) * e),
                int(NAVY_TOP[1] + (NAVY_BOTTOM[1] - NAVY_TOP[1]) * e),
                int(NAVY_TOP[2] + (NAVY_BOTTOM[2] - NAVY_TOP[2]) * e),
            ),
        )
    glow = Image.new("L", (size, size), 0)
    gd = ImageDraw.Draw(glow)
    gd.ellipse(
        [-size * 0.35, -size * 0.55, size * 0.95, size * 0.55],
        fill=70,
    )
    glow = glow.filter(ImageFilter.GaussianBlur(size * 0.18))
    img = Image.composite(Image.new("RGB", (size, size), (30, 68, 122)), img, glow)
    return img


def draw_glyph(img, size):
    """The gothic L, sized to the square and optically centred."""
    font, used = pick_font(int(size * 0.94))
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    box = d.textbbox((0, 0), "L", font=font)
    gw, gh = box[2] - box[0], box[3] - box[1]
    # blackletter L sits high and left; nudge to the optical centre
    x = (size - gw) / 2 - box[0]
    y = (size - gh) / 2 - box[1] + size * 0.015
    # soft dark shadow for depth
    d.text((x + size * 0.012, y + size * 0.016), "L", font=font, fill=(0, 0, 0, 110))
    layer = layer.filter(ImageFilter.GaussianBlur(size * 0.004))
    d2 = ImageDraw.Draw(layer)
    d2.text((x, y), "L", font=font, fill=INK + (255,))
    img.paste(layer, (0, 0), layer)
    return used


def rounded_mask(size, radius_ratio=0.18):
    mask = Image.new("L", (size * 4, size * 4), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, size * 4 - 1, size * 4 - 1],
        radius=int(size * 4 * radius_ratio),
        fill=255,
    )
    return mask.resize((size, size), Image.LANCZOS)


def make(size, rounded=True):
    img = background(size)
    used = draw_glyph(img, size)
    out = img.convert("RGBA")
    if rounded:
        out.putalpha(rounded_mask(size))
    return out, used


# --------------------------------------------------------------------------- #
# in-app brand mark
# --------------------------------------------------------------------------- #
def make_brand_mark(size=96, radius_ratio=0.28):
    """The titlebar mark: the app icon in miniature, as one self-contained PNG."""
    field = Image.new("RGB", (size, size), NAVY_BOTTOM)
    d = ImageDraw.Draw(field)
    for y in range(size):
        t = (y / max(1, size - 1)) ** 0.75
        d.line(
            [(0, y), (size, y)],
            fill=tuple(int(NAVY_TOP[i] + (NAVY_BOTTOM[i] - NAVY_TOP[i]) * t) for i in range(3)),
        )
    field = field.convert("RGBA")

    font, _ = pick_font(int(size * 0.9))
    glyph = Image.new("L", (size, size), 0)
    gd = ImageDraw.Draw(glyph)
    box = gd.textbbox((0, 0), "L", font=font)
    x = (size - (box[2] - box[0])) / 2 - box[0]
    y = (size - (box[3] - box[1])) / 2 - box[1] + size * 0.012
    gd.text((x, y), "L", font=font, fill=255)
    field = Image.composite(Image.new("RGBA", (size, size), INK + (255,)), field, glyph)

    mask = Image.new("L", (size * 4, size * 4), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, size * 4 - 1, size * 4 - 1], radius=int(size * 4 * radius_ratio), fill=255
    )
    field.putalpha(mask.resize((size, size), Image.LANCZOS))
    path = os.path.join(ASSETS, "brand-mark.png")
    field.save(path)
    return path


def main():
    sizes = [16, 24, 32, 48, 64, 128, 256, 512]
    images = []
    used_font = None
    for s in sizes:
        img, used = make(s, rounded=s >= 24)
        used_font = used_font or used
        path = os.path.join(ASSETS, f"icon-{s}.png")
        img.save(path)
        images.append(img)
        print(f"  {os.path.basename(path):<16} {s}x{s}")

    # canonical PNG (used by the app window and the docs)
    images[-1].save(os.path.join(ASSETS, "icon.png"))

    ico_path = os.path.join(ASSETS, "icon.ico")
    images[-1].save(
        ico_path,
        format="ICO",
        sizes=[(s, s) for s in sizes if s <= 256],
    )
    print(f"  icon.ico         {os.path.getsize(ico_path)} bytes, sizes {[s for s in sizes if s <= 256]}")
    mark = make_brand_mark()
    print(f"  {os.path.basename(mark):<16} {os.path.getsize(mark)} bytes (titlebar mark)")
    print(f"  glyph font: {used_font}")


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""LeebertyPDF - image-heavy test corpus.

Builds PDFs that stress the image path: full-page photos (DCTDecode), bilevel
scans (CCITTFax-style raw), many images per page, alpha PNGs (SMask), and a big
single-image page. Written with raw PDF syntax so the corpus is reproducible
without a PDF library.

    python tools/make_image_samples.py
"""
import io
import os
import random
import zlib
from PIL import Image, ImageDraw, ImageFilter

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "samples", "images")
os.makedirs(OUT, exist_ok=True)

rnd = random.Random(20240927)


# --------------------------------------------------------------------------- #
# PDF writer
# --------------------------------------------------------------------------- #
class Pdf:
    def __init__(self, width, height):
        self.width = width
        self.height = height
        self.objects = [None]  # 1-based
        self.pages = []
        # Reserve the page tree up front so pages can reference it while they
        # are being built.
        self.pages_id = self.add(b"PLACEHOLDER")

    def add(self, body):
        """Appends an object and returns its 1-based number."""
        self.objects.append(body)
        return len(self.objects) - 1

    def reserve(self):
        """Appends an empty slot and returns its 1-based number."""
        self.objects.append(None)
        return len(self.objects) - 1

    def set(self, num, body):
        self.objects[num] = body

    def add_stream(self, dict_body, data):
        return self.add(b"<< " + dict_body + b" /Length " + str(len(data)).encode() + b" >>\nstream\n" + data + b"\nendstream")

    def finish(self, path):
        kids = b" ".join(b"%d 0 R" % p for p in self.pages)
        self.set(self.pages_id, b"<< /Type /Pages /Count %d /Kids [%s] >>" % (len(self.pages), kids))
        catalog = self.add(b"<< /Type /Catalog /Pages %d 0 R >>" % self.pages_id)
        out = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
        offsets = [0] * len(self.objects)
        for i in range(1, len(self.objects)):
            offsets[i] = len(out)
            out += b"%d 0 obj\n" % i + self.objects[i] + b"\nendobj\n"
        xref = len(out)
        out += b"xref\n0 %d\n" % len(self.objects)
        out += b"0000000000 65535 f \n"
        for i in range(1, len(self.objects)):
            out += b"%010d 00000 n \n" % offsets[i]
        out += (
            b"trailer\n<< /Size %d /Root %d 0 R >>\nstartxref\n%d\n%%%%EOF\n"
            % (len(self.objects), catalog, xref)
        )
        with open(path, "wb") as fh:
            fh.write(out)
        return len(out)


def content_place(name, w, h, page_w=None, page_h=None, scale=1.0):
    pw = page_w or w
    ph = page_h or h
    draw_w = w * scale
    draw_h = h * scale
    x = (pw - draw_w) / 2
    y = (ph - draw_h) / 2
    return b"q\n%.2f 0 0 %.2f %.2f %.2f cm\n/%s Do\nQ\n" % (
        draw_w,
        draw_h,
        x,
        y,
        name.encode(),
    )


def jpeg_bytes(img, quality, progressive=False):
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality, optimize=True, progressive=progressive)
    return buf.getvalue()


def photo(size, seed):
    """A photo-ish image: gradients + shapes + noise, compressible but detailed."""
    r = random.Random(seed)
    img = Image.new("RGB", size)
    d = ImageDraw.Draw(img)
    for y in range(0, size[1], 4):
        t = y / size[1]
        d.rectangle(
            [0, y, size[0], y + 4],
            fill=(int(40 + 180 * t), int(90 + 120 * (1 - t)), int(160 - 60 * t)),
        )
    for _ in range(90):
        x0, y0 = r.randrange(size[0]), r.randrange(size[1])
        rr = r.randrange(10, max(12, size[0] // 8))
        colour = (r.randrange(256), r.randrange(256), r.randrange(256))
        d.ellipse([x0, y0, x0 + rr, y0 + rr], fill=colour)
    for _ in range(4000):
        d.point((r.randrange(size[0]), r.randrange(size[1])), fill=(r.randrange(256),) * 3)
    return img.filter(ImageFilter.GaussianBlur(0.6))


def build_full_page_photos(path, pages=24, size=(2000, 1500), quality=82):
    """One large photo per page - the classic photo-album / magazine case."""
    doc = Pdf(*size)
    for i in range(pages):
        img = photo(size, i + 1)
        data = jpeg_bytes(img, quality)
        img_id = doc.add_stream(
            b"/Type /XObject /Subtype /Image /Width %d /Height %d /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode"
            % size,
            data,
        )
        content = content_place("Im0", *size)
        content_id = doc.add_stream(b"", content)
        page = doc.add(
            b"<< /Type /Page /Parent %d 0 R /MediaBox [0 0 %d %d] /Resources << /XObject << /Im0 %d 0 R >> >> /Contents %d 0 R >>"
            % (doc.pages_id, size[0], size[1], img_id, content_id)
        )
        doc.pages.append(page)
    return doc.finish(path)


def build_scanned_document(path, pages=30, size=(1275, 1650), quality=60):
    """Scan-like pages: a JPEG background plus noise - typical office scanner output."""
    doc = Pdf(*size)
    for i in range(pages):
        img = Image.new("L", size, 255)
        d = ImageDraw.Draw(img)
        y = 120
        for line in range(46):
            w = rnd.randrange(int(size[0] * 0.35), int(size[0] * 0.86))
            d.rectangle([150, y, 150 + w, y + 12], fill=rnd.randrange(40, 120))
            y += 30
        d.rectangle([150, 60, 150 + 520, 84], fill=20)
        img = img.filter(ImageFilter.GaussianBlur(0.5))
        data = jpeg_bytes(img.convert("RGB"), quality)
        img_id = doc.add_stream(
            b"/Type /XObject /Subtype /Image /Width %d /Height %d /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode"
            % size,
            data,
        )
        content_id = doc.add_stream(b"", content_place("Im0", *size))
        page = doc.add(
            b"<< /Type /Page /Parent %d 0 R /MediaBox [0 0 %d %d] /Resources << /XObject << /Im0 %d 0 R >> >> /Contents %d 0 R >>"
            % (doc.pages_id, size[0], size[1], img_id, content_id)
        )
        doc.pages.append(page)
    return doc.finish(path)


def build_many_per_page(path, pages=12, per_page=24, tile=(320, 240)):
    """A contact sheet / comic grid: many images sharing one page."""
    doc = Pdf(1600, 2200)
    for p in range(pages):
        xobjects = []
        ops = []
        cols, rows = 6, 4
        for i in range(per_page):
            img = photo(tile, p * 100 + i)
            data = jpeg_bytes(img, 70)
            name = "Im%d" % i
            img_id = doc.add_stream(
                b"/Type /XObject /Subtype /Image /Width %d /Height %d /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode"
                % tile,
                data,
            )
            xobjects.append(b"/%s %d 0 R" % (name.encode(), img_id))
            col = i % cols
            row = i // cols
            x = (col + 0.5) * (1600 / cols) - tile[0] / 2
            y = 2200 - (row + 1) * (2100 / rows)
            ops.append(b"q\n%d 0 0 %d %.1f %.1f cm\n/%s Do\nQ\n" % (tile[0], tile[1], x, y, name.encode()))
        content_id = doc.add_stream(b"", b"".join(ops))
        page = doc.add(
            b"<< /Type /Page /Parent %d 0 R /MediaBox [0 0 1600 2200] /Resources << /XObject << %s >> >> /Contents %d 0 R >>"
            % (doc.pages_id, b" ".join(xobjects), content_id)
        )
        doc.pages.append(page)
    return doc.finish(path)


def build_png_alpha(path, pages=8, size=(1400, 1000)):
    """FlateDecode pixels plus an SMask - the transparency decode path."""
    doc = Pdf(*size)
    for p in range(pages):
        rgb = photo(size, 900 + p).convert("RGB")
        alpha = Image.new("L", size, 0)
        d = ImageDraw.Draw(alpha)
        d.ellipse([80, 80, size[0] - 80, size[1] - 80], fill=255)
        alpha = alpha.filter(ImageFilter.GaussianBlur(30))

        rgb_data = zlib.compress(rgb.tobytes(), 6)
        alpha_data = zlib.compress(alpha.tobytes(), 6)
        # reserve both ids up front so the SMask reference is exact
        rgb_id = doc.reserve()
        alpha_id = doc.reserve()
        doc.set(
            rgb_id,
            b"<< /Type /XObject /Subtype /Image /Width %d /Height %d /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /SMask %d 0 R /Length %d >>\nstream\n"
            % (size[0], size[1], alpha_id, len(rgb_data))
            + rgb_data
            + b"\nendstream",
        )
        doc.set(
            alpha_id,
            b"<< /Type /XObject /Subtype /Image /Width %d /Height %d /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length %d >>\nstream\n"
            % (size[0], size[1], len(alpha_data))
            + alpha_data
            + b"\nendstream",
        )
        content_id = doc.add_stream(b"", content_place("Im0", *size))
        page = doc.add(
            b"<< /Type /Page /Parent %d 0 R /MediaBox [0 0 %d %d] /Resources << /XObject << /Im0 %d 0 R >> >> /Contents %d 0 R >>"
            % (doc.pages_id, size[0], size[1], rgb_id, content_id)
        )
        doc.pages.append(page)
    return doc.finish(path)


def build_one_huge_image(path, size=(6000, 4000), quality=88):
    """A single enormous image - the canvas-memory worst case."""
    doc = Pdf(*size)
    img = photo(size, 4242)
    data = jpeg_bytes(img, quality)
    img_id = doc.add_stream(
        b"/Type /XObject /Subtype /Image /Width %d /Height %d /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode"
        % size,
        data,
    )
    content_id = doc.add_stream(b"", content_place("Im0", *size, scale=0.5))
    page = doc.add(
        b"<< /Type /Page /Parent %d 0 R /MediaBox [0 0 %d %d] /Resources << /XObject << /Im0 %d 0 R >> >> /Contents %d 0 R >>"
        % (doc.pages_id, size[0] // 2, size[1] // 2, img_id, content_id)
    )
    doc.pages.append(page)
    return doc.finish(path)


if __name__ == "__main__":
    jobs = [
        ("photos-24p-3mp.pdf", lambda p: build_full_page_photos(p)),
        ("scans-30p.pdf", lambda p: build_scanned_document(p)),
        ("tiles-12p-24img.pdf", lambda p: build_many_per_page(p)),
        ("alpha-png-8p.pdf", lambda p: build_png_alpha(p)),
        ("one-24mp.pdf", lambda p: build_one_huge_image(p)),
    ]
    for name, fn in jobs:
        path = os.path.join(OUT, name)
        size = fn(path)
        print("%-26s %9.2f MB" % (name, size / 1024 / 1024))
    print("written to", OUT)

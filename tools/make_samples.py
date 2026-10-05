"""
LeebertyPDF — deterministic test-corpus generator.

Writes small, valid PDFs (classic xref table, base-14 Helvetica) with real
extractable text, a bookmark outline and page labels, so the reader can be
exercised end to end without depending on any external tool.

    python tools/make_samples.py [outdir]
"""
from __future__ import annotations

import os
import sys
import zlib

PAGE_W, PAGE_H = 595.276, 841.89  # A4 points


def esc(text: str) -> str:
    return text.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")


def content_stream(page_no: int, total: int, landscape: bool) -> bytes:
    w, h = (PAGE_H, PAGE_W) if landscape else (PAGE_W, PAGE_H)
    lines = [
        "BT",
        "/F1 20 Tf",
        f"1 0 0 1 56 {h - 72:.2f} Tm",
        f"(Chapter {page_no} of {total} - The Quick Brown Fox) Tj",
        "ET",
        "BT",
        "/F2 11 Tf",
        "14 TL",
        f"1 0 0 1 56 {h - 108:.2f} Tm",
    ]
    body = [
        f"Page {page_no}: lorem ipsum dolor sit amet, consectetur adipiscing elit,",
        "sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.",
        "Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.",
        "",
        f"KEY TERM {page_no} — LeebertyPDF highlight target paragraph.",
        "Highlight me, underline me, draw on me, search me.",
        "",
        f"- item alpha {page_no}",
        f"- item beta {page_no}",
        f"- item gamma {page_no}",
        "",
        "The quick brown fox jumps over the lazy dog. 0123456789.",
        "Performance zoom search annotation bookmark outline night mode.",
    ]
    for ln in body:
        lines.append(f"({esc(ln)}) Tj T*")
    lines.append("ET")
    # a light rule and a box so the page is not plain white
    lines += [
        "0.85 0.89 0.94 rg",
        f"56 {h - 96:.2f} {w - 112:.2f} 3 re f",
        "0.96 0.97 0.99 rg",
        f"56 96 {w - 112:.2f} 56 re f",
        "0.30 0.35 0.42 rg",
        "BT",
        "/F2 9 Tf",
        f"1 0 0 1 66 130 Tm",
        f"(LeebertyPDF test corpus · generated page {page_no}) Tj",
        "ET",
    ]
    return "\n".join(lines).encode("latin-1", "replace")


class PdfBuilder:
    """Very small single-generation PDF writer."""

    def __init__(self) -> None:
        self.objects: list[bytes] = []

    def add(self, payload: bytes) -> int:
        self.objects.append(payload)
        return len(self.objects)

    def reserve(self) -> int:
        self.objects.append(b"")
        return len(self.objects)

    def set(self, num: int, payload: bytes) -> None:
        self.objects[num - 1] = payload

    def build(self, root_num: int) -> bytes:
        out = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
        offsets = [0] * (len(self.objects) + 1)
        for i, payload in enumerate(self.objects, start=1):
            offsets[i] = len(out)
            out += f"{i} 0 obj\n".encode("ascii") + payload + b"\nendobj\n"
        xref_at = len(out)
        count = len(self.objects) + 1
        out += f"xref\n0 {count}\n".encode("ascii")
        out += b"0000000000 65535 f \n"
        for i in range(1, count):
            out += f"{offsets[i]:010d} 00000 n \n".encode("ascii")
        out += (
            f"trailer\n<< /Size {count} /Root {root_num} 0 R >>\nstartxref\n{xref_at}\n%%EOF\n"
        ).encode("ascii")
        return bytes(out)


def build_pdf(path: str, pages: int, landscape: bool = False, title: str = "") -> None:
    w, h = (PAGE_H, PAGE_W) if landscape else (PAGE_W, PAGE_H)
    b = PdfBuilder()

    catalog = b.reserve()
    pages_node = b.reserve()
    font1 = b.add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>")
    font2 = b.add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
    res = b.add(
        f"<< /Font << /F1 {font1} 0 R /F2 {font2} 0 R >> /ProcSet [/PDF /Text] >>".encode("ascii")
    )
    info = b.add(
        (
            f"<< /Title ({esc(title or os.path.basename(path))}) "
            f"/Author (LeebertyPDF test corpus) /Creator (make_samples.py) "
            f"/Producer (Lumen) /Subject (reader test document) "
            f"/Keywords (lumen, pdf, test, sample) >>"
        ).encode("latin-1")
    )

    page_refs = []
    for i in range(1, pages + 1):
        content = zlib.compress(content_stream(i, pages, landscape))
        cnum = b.add(
            b"<< /Length " + str(len(content)).encode() + b" /Filter /FlateDecode >>\nstream\n" + content + b"\nendstream"
        )
        pnum = b.add(
            (
                f"<< /Type /Page /Parent {pages_node} 0 R /MediaBox [0 0 {w:.3f} {h:.3f}] "
                f"/Resources {res} 0 R /Contents {cnum} 0 R >>"
            ).encode("ascii")
        )
        page_refs.append(pnum)

    kids = " ".join(f"{n} 0 R" for n in page_refs)
    b.set(
        pages_node,
        f"<< /Type /Pages /Count {pages} /Kids [{kids}] >>".encode("ascii"),
    )

    # outline: one entry every 10 pages (plus the first), each pointing at its page
    outline_root = b.reserve()
    labels = [1] + list(range(11, pages + 1, 10))
    item_nums = [b.reserve() for _ in labels]
    page_obj = {}
    for idx, n in enumerate(labels):
        nxt = f"{item_nums[idx + 1]} 0 R" if idx + 1 < len(item_nums) else "null"
        prv = f"{item_nums[idx - 1]} 0 R" if idx > 0 else "null"
        # /Dest with an explicit page reference plus a named destination
        dest = f"/Dest [{page_refs[n - 1]} 0 R /Fit]"
        b.set(
            item_nums[idx],
            (
                f"<< /Title (Chapter {n}) /Parent {outline_root} 0 R "
                f"{dest} /Prev {prv} /Next {nxt} >>"
            ).encode("ascii"),
        )
    b.set(
        outline_root,
        (
            f"<< /Type /Outlines /First {item_nums[0]} 0 R /Last {item_nums[-1]} 0 R "
            f"/Count {len(item_nums)} >>"
        ).encode("ascii"),
    )

    b.set(
        catalog,
        (
            f"<< /Type /Catalog /Pages {pages_node} 0 R /Outlines {outline_root} 0 R "
            f"/PageMode /UseOutlines /Lang (zh-CN) >>"
        ).encode("ascii"),
    )

    data = b.build(catalog)
    with open(path, "wb") as fh:
        fh.write(data)
    print(f"{os.path.basename(path)}: {len(data)} bytes, {pages} pages")


def main() -> None:
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "samples")
    out = os.path.abspath(out)
    os.makedirs(out, exist_ok=True)
    build_pdf(os.path.join(out, "sample-small.pdf"), 12, False, "Lumen test document - 12 pages")
    build_pdf(os.path.join(out, "sample-large.pdf"), 240, False, "Lumen stress test - 240 pages")
    build_pdf(os.path.join(out, "sample-landscape.pdf"), 8, True, "Lumen landscape - 8 pages")
    build_pdf(os.path.join(out, "sample-tiny.pdf"), 1, False, "Lumen single page")


if __name__ == "__main__":
    main()

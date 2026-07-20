"""Non-fillable PDF annotation operations.

Usage:
    python layout.py extract <input.pdf> <output.json>
    python layout.py preview <page_number> <fields.json> <input_image> <output_image>
    python layout.py fill <input.pdf> <fields.json> <output.pdf>
"""

import json
import sys
from dataclasses import dataclass, field
from pathlib import Path

import pdfplumber
from PIL import Image, ImageDraw
from pypdf import PdfReader, PdfWriter
from pypdf.annotations import FreeText

CHECKBOX_MIN_SIZE = 5
CHECKBOX_MAX_SIZE = 15
CHECKBOX_ASPECT_TOLERANCE = 2
LINE_MIN_WIDTH_RATIO = 0.5


@dataclass
class PageLayout:
    page_number: int
    width: float
    height: float
    text_elements: list[dict] = field(default_factory=list)
    h_rules: list[dict] = field(default_factory=list)
    tick_boxes: list[dict] = field(default_factory=list)
    row_ranges: list[dict] = field(default_factory=list)


@dataclass
class CoordMapper:
    pdf_w: float
    pdf_h: float
    coord_system: str = "pdf"
    source_w: float = 0.0
    source_h: float = 0.0

    def to_annotation_rect(self, bbox: list[float]) -> tuple[float, float, float, float]:
        match self.coord_system:
            case "image":
                sx = self.pdf_w / self.source_w
                sy = self.pdf_h / self.source_h
                return (
                    bbox[0] * sx,
                    self.pdf_h - bbox[3] * sy,
                    bbox[2] * sx,
                    self.pdf_h - bbox[1] * sy,
                )
            case _:
                return (
                    bbox[0],
                    self.pdf_h - bbox[3],
                    bbox[2],
                    self.pdf_h - bbox[1],
                )


def _extract_page(page: pdfplumber.page.Page, page_num: int) -> PageLayout:
    layout = PageLayout(
        page_number=page_num,
        width=round(float(page.width), 1),
        height=round(float(page.height), 1),
    )

    min_line_span = page.width * LINE_MIN_WIDTH_RATIO

    for obj in page.objects.get("line", []):
        span = abs(float(obj["x1"]) - float(obj["x0"]))
        if span > min_line_span:
            layout.h_rules.append(
                {
                    "y": round(float(obj["top"]), 1),
                    "x0": round(float(obj["x0"]), 1),
                    "x1": round(float(obj["x1"]), 1),
                }
            )

    for obj in page.objects.get("rect", []):
        w = float(obj["x1"]) - float(obj["x0"])
        h = float(obj["bottom"]) - float(obj["top"])
        area = w * h
        aspect = w / h if h > 0 else 0
        if (
            area <= CHECKBOX_MAX_SIZE**2
            and area >= CHECKBOX_MIN_SIZE**2
            and 1 / CHECKBOX_ASPECT_TOLERANCE < aspect < CHECKBOX_ASPECT_TOLERANCE
        ):
            mid_x = (float(obj["x0"]) + float(obj["x1"])) / 2
            mid_y = (float(obj["top"]) + float(obj["bottom"])) / 2
            layout.tick_boxes.append(
                {
                    "x0": round(float(obj["x0"]), 1),
                    "top": round(float(obj["top"]), 1),
                    "x1": round(float(obj["x1"]), 1),
                    "bottom": round(float(obj["bottom"]), 1),
                    "mid_x": round(mid_x, 1),
                    "mid_y": round(mid_y, 1),
                }
            )

    for word in page.extract_words():
        layout.text_elements.append(
            {
                "text": word["text"],
                "x0": round(float(word["x0"]), 1),
                "top": round(float(word["top"]), 1),
                "x1": round(float(word["x1"]), 1),
                "bottom": round(float(word["bottom"]), 1),
            }
        )

    return layout


def _compute_row_ranges(layout: PageLayout) -> None:
    y_vals = sorted({rule["y"] for rule in layout.h_rules})
    for i in range(len(y_vals) - 1):
        layout.row_ranges.append(
            {
                "top": y_vals[i],
                "bottom": y_vals[i + 1],
                "height": round(y_vals[i + 1] - y_vals[i], 1),
            }
        )


def _extract_all_pages(pdf_path: str) -> list[PageLayout]:
    pages: list[PageLayout] = []
    with pdfplumber.open(pdf_path) as pdf:
        for page_num, page in enumerate(pdf.pages, 1):
            layout = _extract_page(page, page_num)
            _compute_row_ranges(layout)
            pages.append(layout)
    return pages


def _pages_to_dict(pages: list[PageLayout]) -> list[dict]:
    return [
        {
            "page_number": p.page_number,
            "width": p.width,
            "height": p.height,
            "text_elements": p.text_elements,
            "h_rules": p.h_rules,
            "tick_boxes": p.tick_boxes,
            "row_ranges": p.row_ranges,
        }
        for p in pages
    ]


def _validate_and_fill(input_path: str, fields_path: str, output_path: str) -> None:
    data = json.loads(Path(fields_path).read_text())
    coord_system = data.get("coord_system", "pdf")

    reader = PdfReader(input_path)
    writer = PdfWriter()
    writer.append(reader)

    page_dims: dict[int, tuple[float, float]] = {}
    for i, page in enumerate(reader.pages):
        mb = page.mediabox
        page_dims[i + 1] = (float(mb.width), float(mb.height))

    page_info_map: dict[int, dict] = {p["page_number"]: p for p in data.get("pages", [])}

    errors: list[str] = []
    placed: list[tuple[int, list[float], str]] = []

    for field_def in data.get("form_fields", []):
        content = field_def.get("content")
        if not content or not content.get("text"):
            continue

        pg = field_def["page_number"]
        desc = field_def.get("description", "unnamed")
        area = field_def["content_area"]
        label = field_def.get("label_box", [0, 0, 0, 0])

        font_size = content.get("font_size", 14)
        box_h = area[3] - area[1]
        if box_h < font_size:
            errors.append(f"Content area height ({box_h:.1f}) too small for font size ({font_size}) in '{desc}'")

        for prev_pg, prev_rect, prev_desc in placed:
            if prev_pg != pg:
                continue
            for tag, rect in [("content", area), ("label", label)]:
                if _rects_overlap(prev_rect, rect):
                    errors.append(f"Overlap: '{prev_desc}' and {tag} of '{desc}'")

        if errors and len(errors) >= 15:
            errors.append("Too many errors — fix and retry")
            break

        placed.append((pg, area, desc))
        if label != [0, 0, 0, 0]:
            placed.append((pg, label, desc))

        pdf_w, pdf_h = page_dims[pg]
        info = page_info_map.get(pg, {})
        mapper = CoordMapper(
            pdf_w=pdf_w,
            pdf_h=pdf_h,
            coord_system=coord_system,
            source_w=info.get("width", pdf_w),
            source_h=info.get("height", pdf_h),
        )
        rect = mapper.to_annotation_rect(area)

        annotation = FreeText(
            text=content["text"],
            rect=rect,
            font=content.get("font", "Arial"),
            font_size=str(font_size) + "pt",
            font_color=content.get("font_color", "000000"),
            border_color=None,
            background_color=None,
        )
        writer.add_annotation(page_number=pg - 1, annotation=annotation)

    if errors:
        for err in errors:
            print(f"ERROR: {err}")
        sys.exit(1)

    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "wb") as f:
        writer.write(f)

    print(f"Placed {len(placed)} annotations → {output_path}")


def _rects_overlap(a: list[float], b: list[float]) -> bool:
    return not (a[0] >= b[2] or b[0] >= a[2] or a[1] >= b[3] or b[1] >= a[3])


def cmd_extract(args: list[str]) -> None:
    if len(args) != 2:
        print("Usage: layout.py extract <input.pdf> <output.json>")
        sys.exit(1)
    pdf_path, output_path = args
    print(f"Scanning {pdf_path}...")

    pages = _extract_all_pages(pdf_path)
    output = _pages_to_dict(pages)

    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    Path(output_path).write_text(json.dumps(output, indent=2))

    totals = {
        "text_elements": sum(len(p.text_elements) for p in pages),
        "h_rules": sum(len(p.h_rules) for p in pages),
        "tick_boxes": sum(len(p.tick_boxes) for p in pages),
        "row_ranges": sum(len(p.row_ranges) for p in pages),
    }
    print(
        f"{len(pages)} pages: {totals['text_elements']} text elements, "
        f"{totals['h_rules']} rules, {totals['tick_boxes']} tick boxes, "
        f"{totals['row_ranges']} row ranges → {output_path}"
    )


def cmd_preview(args: list[str]) -> None:
    if len(args) != 4:
        print("Usage: layout.py preview <page_number> <fields.json> <input_image> <output_image>")
        sys.exit(1)
    page_number = int(args[0])
    data = json.loads(Path(args[1]).read_text())

    img = Image.open(args[2])
    draw = ImageDraw.Draw(img)
    count = 0

    for field_def in data.get("form_fields", []):
        if field_def["page_number"] != page_number:
            continue
        draw.rectangle(field_def["content_area"], outline="red", width=2)
        if "label_box" in field_def:
            draw.rectangle(field_def["label_box"], outline="blue", width=2)
        count += 1

    Path(args[3]).parent.mkdir(parents=True, exist_ok=True)
    img.save(args[3])
    print(f"Preview saved to {args[3]} ({count} fields highlighted)")


def cmd_fill(args: list[str]) -> None:
    if len(args) != 3:
        print("Usage: layout.py fill <input.pdf> <fields.json> <output.pdf>")
        sys.exit(1)
    _validate_and_fill(args[0], args[1], args[2])


SUBCOMMANDS = {
    "extract": cmd_extract,
    "preview": cmd_preview,
    "fill": cmd_fill,
}


def main() -> None:
    if len(sys.argv) < 2 or sys.argv[1] not in SUBCOMMANDS:
        print(f"Usage: layout.py <{'|'.join(SUBCOMMANDS)}> [args...]")
        sys.exit(1)
    SUBCOMMANDS[sys.argv[1]](sys.argv[2:])


if __name__ == "__main__":
    main()

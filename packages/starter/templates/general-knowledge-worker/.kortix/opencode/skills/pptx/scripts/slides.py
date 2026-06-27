"""Consolidated PPTX slide manipulation CLI.

Subcommands:
    clean       Remove unreferenced files from an unpacked PPTX directory
    add         Duplicate a slide or create one from a layout
    thumbnail   Create a visual grid of slide thumbnails

Usage:
    python slides.py clean <unpacked_dir>
    python slides.py add <unpacked_dir> <source>
    python slides.py thumbnail <input.pptx> [output_prefix] [--cols N]
"""

import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

from lxml import etree
from PIL import Image, ImageDraw, ImageFont

PKG_RELS_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
PRES_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"
OFFDOC_RELS_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types"

SLIDE_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide"
LAYOUT_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout"
NOTES_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide"

SLIDE_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.slide+xml"

THUMB_WIDTH = 320
RENDER_DPI = 150
COLS_MAX = 6
COLS_DEFAULT = 4
JPG_QUALITY = 90
CELL_SPACING = 16
OUTLINE_PX = 1
LABEL_SIZE_FACTOR = 0.08
LABEL_PAD_FACTOR = 0.3

RESOURCE_DIRS = ["media", "embeddings", "charts", "diagrams", "tags", "drawings", "ink"]
TRASH_DIR_NAME = "[trash]"


def _parse_xml(path: Path) -> etree._Element:
    return etree.parse(str(path)).getroot()


def _write_xml(root: etree._Element, path: Path) -> None:
    path.write_bytes(etree.tostring(root, xml_declaration=True, encoding="utf-8"))


def _collect_all_targets(unpacked_dir: Path) -> set[Path]:
    resolved_base = unpacked_dir.resolve()
    targets = set()
    for rels_file in unpacked_dir.rglob("*.rels"):
        root = _parse_xml(rels_file)
        for rel in root.findall(f"{{{PKG_RELS_NS}}}Relationship"):
            target = rel.get("Target")
            if not target:
                continue
            resolved = (rels_file.parent.parent / target).resolve()
            try:
                targets.add(resolved.relative_to(resolved_base))
            except ValueError:
                pass
    return targets


def _active_slide_names(unpacked_dir: Path) -> set[str]:
    pres_path = unpacked_dir / "ppt" / "presentation.xml"
    pres_rels_path = unpacked_dir / "ppt" / "_rels" / "presentation.xml.rels"
    if not pres_path.exists() or not pres_rels_path.exists():
        return set()

    rels_root = _parse_xml(pres_rels_path)
    rid_to_name: dict[str, str] = {}
    for rel in rels_root.findall(f"{{{PKG_RELS_NS}}}Relationship"):
        target = rel.get("Target", "")
        if target.startswith("slides/") and "slide" in rel.get("Type", ""):
            rid_to_name[rel.get("Id")] = target.removeprefix("slides/")

    pres_text = pres_path.read_text(encoding="utf-8")
    active_rids = set(re.findall(r'<p:sldId[^>]*r:id="([^"]+)"', pres_text))
    return {rid_to_name[rid] for rid in active_rids if rid in rid_to_name}


def _purge_trash(unpacked_dir: Path) -> list[str]:
    trash = unpacked_dir / TRASH_DIR_NAME
    deleted: list[str] = []
    if not trash.is_dir():
        return deleted
    for f in trash.iterdir():
        if f.is_file():
            deleted.append(str(f.relative_to(unpacked_dir)))
            f.unlink()
    trash.rmdir()
    return deleted


def _remove_orphan_slides(unpacked_dir: Path, active: set[str]) -> list[str]:
    slides_dir = unpacked_dir / "ppt" / "slides"
    rels_dir = slides_dir / "_rels"
    deleted: list[str] = []

    if not slides_dir.exists():
        return deleted

    for slide_xml in slides_dir.glob("slide*.xml"):
        if slide_xml.name in active:
            continue
        deleted.append(str(slide_xml.relative_to(unpacked_dir)))
        slide_xml.unlink()
        companion_rels = rels_dir / f"{slide_xml.name}.rels"
        if companion_rels.exists():
            deleted.append(str(companion_rels.relative_to(unpacked_dir)))
            companion_rels.unlink()

    pres_rels_path = unpacked_dir / "ppt" / "_rels" / "presentation.xml.rels"
    if deleted and pres_rels_path.exists():
        root = _parse_xml(pres_rels_path)
        for rel in list(root.findall(f"{{{PKG_RELS_NS}}}Relationship")):
            target = rel.get("Target", "")
            if target.startswith("slides/") and target.removeprefix("slides/") not in active:
                root.remove(rel)
        _write_xml(root, pres_rels_path)

    return deleted


def _remove_unreferenced_resources(unpacked_dir: Path, referenced: set[Path]) -> list[str]:
    deleted: list[str] = []

    for dir_name in RESOURCE_DIRS:
        dir_path = unpacked_dir / "ppt" / dir_name
        if not dir_path.exists():
            continue
        for f in dir_path.iterdir():
            if not f.is_file():
                continue
            rel = f.relative_to(unpacked_dir)
            if rel not in referenced:
                f.unlink()
                deleted.append(str(rel))
        rels_subdir = dir_path / "_rels"
        if rels_subdir.exists():
            for rf in list(rels_subdir.glob("*.rels")):
                parent_file = dir_path / rf.name.removesuffix(".rels")
                if not parent_file.exists():
                    deleted.append(str(rf.relative_to(unpacked_dir)))
                    rf.unlink()

    theme_dir = unpacked_dir / "ppt" / "theme"
    if theme_dir.exists():
        for f in theme_dir.glob("theme*.xml"):
            rel = f.relative_to(unpacked_dir)
            if rel not in referenced:
                f.unlink()
                deleted.append(str(rel))
                theme_rels = theme_dir / "_rels" / f"{f.name}.rels"
                if theme_rels.exists():
                    theme_rels.unlink()
                    deleted.append(str(theme_rels.relative_to(unpacked_dir)))

    notes_dir = unpacked_dir / "ppt" / "notesSlides"
    if notes_dir.exists():
        for f in notes_dir.glob("*.xml"):
            rel = f.relative_to(unpacked_dir)
            if rel not in referenced:
                f.unlink()
                deleted.append(str(rel))
        notes_rels = notes_dir / "_rels"
        if notes_rels.exists():
            for rf in list(notes_rels.glob("*.rels")):
                parent = notes_dir / rf.name.removesuffix(".rels")
                if not parent.exists():
                    rf.unlink()
                    deleted.append(str(rf.relative_to(unpacked_dir)))

    return deleted


def _strip_stale_content_types(unpacked_dir: Path, removed_parts: list[str]) -> None:
    ct_path = unpacked_dir / "[Content_Types].xml"
    if not ct_path.exists() or not removed_parts:
        return
    removed_set = set(removed_parts)
    root = _parse_xml(ct_path)
    ns = f"{{{CT_NS}}}" if CT_NS in (root.tag or "") else ""
    if not ns and "}" in root.tag:
        ns = root.tag.split("}")[0] + "}"
    changed = False
    for override in list(root.findall(f"{ns}Override")):
        part = override.get("PartName", "").lstrip("/")
        if part in removed_set:
            root.remove(override)
            changed = True
    if changed:
        _write_xml(root, ct_path)


def run_clean(unpacked_dir: Path) -> list[str]:
    all_deleted: list[str] = []

    active = _active_slide_names(unpacked_dir)
    all_deleted.extend(_remove_orphan_slides(unpacked_dir, active))
    all_deleted.extend(_purge_trash(unpacked_dir))

    while True:
        referenced = _collect_all_targets(unpacked_dir)
        batch = _remove_unreferenced_resources(unpacked_dir, referenced)
        if not batch:
            break
        all_deleted.extend(batch)

    _strip_stale_content_types(unpacked_dir, all_deleted)
    return all_deleted


# ---------------------------------------------------------------------------
# add subcommand
# ---------------------------------------------------------------------------

BLANK_SLIDE_TEMPLATE = """\
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr>
        <p:cNvPr id="1" name=""/>
        <p:cNvGrpSpPr/>
        <p:nvPr/>
      </p:nvGrpSpPr>
      <p:grpSpPr>
        <a:xfrm>
          <a:off x="0" y="0"/>
          <a:ext cx="0" cy="0"/>
          <a:chOff x="0" y="0"/>
          <a:chExt cx="0" cy="0"/>
        </a:xfrm>
      </p:grpSpPr>
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr>
    <a:masterClrMapping/>
  </p:clrMapOvr>
</p:sld>"""

SLIDE_RELS_TEMPLATE = """\
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="{layout_type}" Target="../slideLayouts/{layout}"/>
</Relationships>"""


def _next_slide_number(slides_dir: Path) -> int:
    nums = [int(m.group(1)) for f in slides_dir.glob("slide*.xml") if (m := re.match(r"slide(\d+)\.xml", f.name))]
    return max(nums) + 1 if nums else 1


def _register_content_type(unpacked_dir: Path, slide_filename: str) -> None:
    ct_path = unpacked_dir / "[Content_Types].xml"
    root = _parse_xml(ct_path)
    ns = root.tag.split("}")[0] + "}" if "}" in root.tag else ""
    part_name = f"/ppt/slides/{slide_filename}"
    for existing in root.findall(f"{ns}Override"):
        if existing.get("PartName") == part_name:
            return
    etree.SubElement(root, f"{ns}Override", PartName=part_name, ContentType=SLIDE_CONTENT_TYPE)
    _write_xml(root, ct_path)


def _register_presentation_rel(unpacked_dir: Path, slide_filename: str) -> str:
    pres_rels_path = unpacked_dir / "ppt" / "_rels" / "presentation.xml.rels"
    root = _parse_xml(pres_rels_path)

    max_rid = 0
    for rel in root.findall(f"{{{PKG_RELS_NS}}}Relationship"):
        rid_str = rel.get("Id", "")
        if m := re.match(r"rId(\d+)", rid_str):
            max_rid = max(max_rid, int(m.group(1)))
        target = rel.get("Target", "")
        if target == f"slides/{slide_filename}":
            return rel.get("Id")

    new_rid = f"rId{max_rid + 1}"
    etree.SubElement(
        root,
        f"{{{PKG_RELS_NS}}}Relationship",
        Id=new_rid,
        Type=SLIDE_REL_TYPE,
        Target=f"slides/{slide_filename}",
    )
    _write_xml(root, pres_rels_path)
    return new_rid


def _next_slide_id(unpacked_dir: Path) -> int:
    pres_path = unpacked_dir / "ppt" / "presentation.xml"
    ids = [int(x) for x in re.findall(r'<p:sldId[^>]*id="(\d+)"', pres_path.read_text(encoding="utf-8"))]
    return max(ids) + 1 if ids else 256


def _create_from_layout(unpacked_dir: Path, layout_name: str) -> None:
    layouts_dir = unpacked_dir / "ppt" / "slideLayouts"
    layout_path = layouts_dir / layout_name
    if not layout_path.exists():
        print(f"Error: {layout_path} not found", file=sys.stderr)
        sys.exit(1)

    slides_dir = unpacked_dir / "ppt" / "slides"
    rels_dir = slides_dir / "_rels"
    rels_dir.mkdir(exist_ok=True)

    num = _next_slide_number(slides_dir)
    new_name = f"slide{num}.xml"
    (slides_dir / new_name).write_text(BLANK_SLIDE_TEMPLATE, encoding="utf-8")
    (rels_dir / f"{new_name}.rels").write_text(
        SLIDE_RELS_TEMPLATE.format(layout_type=LAYOUT_REL_TYPE, layout=layout_name),
        encoding="utf-8",
    )

    _register_content_type(unpacked_dir, new_name)
    rid = _register_presentation_rel(unpacked_dir, new_name)
    sid = _next_slide_id(unpacked_dir)
    print(f"Created {new_name} from {layout_name}")
    print(f'Add to presentation.xml <p:sldIdLst>: <p:sldId id="{sid}" r:id="{rid}"/>')


def _clone_existing(unpacked_dir: Path, source_name: str) -> None:
    slides_dir = unpacked_dir / "ppt" / "slides"
    rels_dir = slides_dir / "_rels"
    source_path = slides_dir / source_name

    if not source_path.exists():
        print(f"Error: {source_path} not found", file=sys.stderr)
        sys.exit(1)

    num = _next_slide_number(slides_dir)
    new_name = f"slide{num}.xml"
    shutil.copy2(source_path, slides_dir / new_name)

    source_rels = rels_dir / f"{source_name}.rels"
    dest_rels = rels_dir / f"{new_name}.rels"
    if source_rels.exists():
        shutil.copy2(source_rels, dest_rels)
        root = _parse_xml(dest_rels)
        for rel in list(root.findall(f"{{{PKG_RELS_NS}}}Relationship")):
            if NOTES_REL_TYPE in (rel.get("Type") or ""):
                root.remove(rel)
        _write_xml(root, dest_rels)

    _register_content_type(unpacked_dir, new_name)
    rid = _register_presentation_rel(unpacked_dir, new_name)
    sid = _next_slide_id(unpacked_dir)
    print(f"Created {new_name} from {source_name}")
    print(f'Add to presentation.xml <p:sldIdLst>: <p:sldId id="{sid}" r:id="{rid}"/>')


def run_add(unpacked_dir: Path, source: str) -> None:
    if source.startswith("slideLayout") and source.endswith(".xml"):
        _create_from_layout(unpacked_dir, source)
    else:
        _clone_existing(unpacked_dir, source)


# ---------------------------------------------------------------------------
# thumbnail subcommand
# ---------------------------------------------------------------------------


def _extract_slide_order(pptx_path: Path) -> list[dict]:
    with zipfile.ZipFile(pptx_path, "r") as zf:
        rels_root = etree.fromstring(zf.read("ppt/_rels/presentation.xml.rels"))
        rid_map: dict[str, str] = {}
        for rel in rels_root.findall(f"{{{PKG_RELS_NS}}}Relationship"):
            target = rel.get("Target", "")
            if target.startswith("slides/") and "slide" in rel.get("Type", ""):
                rid_map[rel.get("Id")] = target.removeprefix("slides/")

        pres_root = etree.fromstring(zf.read("ppt/presentation.xml"))
        ordered: list[dict] = []
        for sid in pres_root.iter(f"{{{PRES_NS}}}sldId"):
            rid = sid.get(f"{{{OFFDOC_RELS_NS}}}id")
            if rid in rid_map:
                ordered.append({"name": rid_map[rid], "hidden": sid.get("show") == "0"})
        return ordered


def _render_slide_images(pptx_path: Path, work_dir: Path) -> list[Path]:
    pdf_out = work_dir / f"{pptx_path.stem}.pdf"
    env = {**os.environ, "SAL_USE_VCLPLUGIN": "svp"}
    proc = subprocess.run(
        ["soffice", "--headless", "--convert-to", "pdf", "--outdir", str(work_dir), str(pptx_path)],
        capture_output=True,
        text=True,
        env=env,
    )
    if proc.returncode != 0 or not pdf_out.exists():
        raise RuntimeError("PDF conversion failed")

    proc = subprocess.run(
        ["pdftoppm", "-jpeg", "-r", str(RENDER_DPI), str(pdf_out), str(work_dir / "slide")],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError("Image conversion failed")

    return sorted(work_dir.glob("slide-*.jpg"))


def _make_hidden_placeholder(dimensions: tuple[int, int]) -> Image.Image:
    img = Image.new("RGB", dimensions, color="#E8E8E8")
    draw = ImageDraw.Draw(img)
    stroke = max(3, min(dimensions) // 80)
    draw.line([(0, 0), dimensions], fill="#B0B0B0", width=stroke)
    draw.line([(dimensions[0], 0), (0, dimensions[1])], fill="#B0B0B0", width=stroke)
    return img


def _pair_slides_with_images(
    slide_order: list[dict],
    rendered: list[Path],
    work_dir: Path,
) -> list[tuple[Path, str]]:
    placeholder_dims = (1920, 1080)
    if rendered:
        with Image.open(rendered[0]) as img:
            placeholder_dims = img.size

    pairs: list[tuple[Path, str]] = []
    vis_idx = 0
    for entry in slide_order:
        if entry["hidden"]:
            ph_path = work_dir / f"hidden-{entry['name']}.jpg"
            _make_hidden_placeholder(placeholder_dims).save(ph_path, "JPEG")
            pairs.append((ph_path, f"{entry['name']} (hidden)"))
        elif vis_idx < len(rendered):
            pairs.append((rendered[vis_idx], entry["name"]))
            vis_idx += 1
    return pairs


def _compose_grid(
    items: list[tuple[Path, str]],
    cols: int,
    cell_w: int,
) -> Image.Image:
    label_h = int(cell_w * LABEL_SIZE_FACTOR)
    pad_label = int(label_h * LABEL_PAD_FACTOR)

    with Image.open(items[0][0]) as sample:
        aspect = sample.height / sample.width
    cell_h = int(cell_w * aspect)

    n_rows = -(-len(items) // cols)
    row_height = cell_h + label_h + 2 * pad_label
    canvas_w = cols * cell_w + (cols + 1) * CELL_SPACING
    canvas_h = n_rows * row_height + (n_rows + 1) * CELL_SPACING

    canvas = Image.new("RGB", (canvas_w, canvas_h), "white")
    draw = ImageDraw.Draw(canvas)

    try:
        font = ImageFont.load_default(size=label_h)
    except Exception:
        font = ImageFont.load_default()

    for idx, (img_path, label) in enumerate(items):
        r, c = divmod(idx, cols)
        x0 = c * cell_w + (c + 1) * CELL_SPACING
        y0 = r * row_height + (r + 1) * CELL_SPACING

        bbox = draw.textbbox((0, 0), label, font=font)
        tw = bbox[2] - bbox[0]
        draw.text((x0 + (cell_w - tw) // 2, y0 + pad_label), label, fill="black", font=font)

        y_img = y0 + pad_label + label_h + pad_label
        with Image.open(img_path) as slide_img:
            slide_img.thumbnail((cell_w, cell_h), Image.Resampling.LANCZOS)
            sw, sh = slide_img.size
            tx = x0 + (cell_w - sw) // 2
            ty = y_img + (cell_h - sh) // 2
            canvas.paste(slide_img, (tx, ty))
            if OUTLINE_PX > 0:
                draw.rectangle(
                    [(tx - OUTLINE_PX, ty - OUTLINE_PX), (tx + sw + OUTLINE_PX - 1, ty + sh + OUTLINE_PX - 1)],
                    outline="gray",
                    width=OUTLINE_PX,
                )

    return canvas


def run_thumbnail(pptx_path: Path, output_prefix: str, cols: int) -> list[str]:
    slide_order = _extract_slide_order(pptx_path)

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        rendered = _render_slide_images(pptx_path, tmp_path)

        if not rendered and not any(s["hidden"] for s in slide_order):
            print("Error: No slides found", file=sys.stderr)
            sys.exit(1)

        pairs = _pair_slides_with_images(slide_order, rendered, tmp_path)
        capacity = cols * (cols + 1)
        out_base = Path(f"{output_prefix}.jpg")
        saved: list[str] = []

        for chunk_i, start in enumerate(range(0, len(pairs), capacity)):
            chunk = pairs[start : start + capacity]
            grid = _compose_grid(chunk, cols, THUMB_WIDTH)

            if len(pairs) <= capacity:
                dest = out_base
            else:
                dest = out_base.parent / f"{out_base.stem}-{chunk_i + 1}{out_base.suffix}"

            dest.parent.mkdir(parents=True, exist_ok=True)
            grid.save(str(dest), quality=JPG_QUALITY)
            saved.append(str(dest))

    return saved


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _cmd_clean(args: argparse.Namespace) -> None:
    unpacked = Path(args.unpacked_dir)
    if not unpacked.exists():
        print(f"Error: {unpacked} not found", file=sys.stderr)
        sys.exit(1)
    removed = run_clean(unpacked)
    if removed:
        print(f"Removed {len(removed)} unreferenced files:")
        for f in removed:
            print(f"  {f}")
    else:
        print("No unreferenced files found")


def _cmd_add(args: argparse.Namespace) -> None:
    unpacked = Path(args.unpacked_dir)
    if not unpacked.exists():
        print(f"Error: {unpacked} not found", file=sys.stderr)
        sys.exit(1)
    run_add(unpacked, args.source)


def _cmd_thumbnail(args: argparse.Namespace) -> None:
    pptx_path = Path(args.input)
    if not pptx_path.exists() or pptx_path.suffix.lower() != ".pptx":
        print(f"Error: Invalid PowerPoint file: {args.input}", file=sys.stderr)
        sys.exit(1)
    cols = min(args.cols, COLS_MAX)
    if args.cols > COLS_MAX:
        print(f"Warning: Columns limited to {COLS_MAX}")
    try:
        saved = run_thumbnail(pptx_path, args.output_prefix, cols)
        print(f"Created {len(saved)} grid(s):")
        for gf in saved:
            print(f"  {gf}")
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="slides.py", description="PPTX slide manipulation tools")
    subs = parser.add_subparsers(dest="command", required=True)

    p_clean = subs.add_parser("clean", help="Remove unreferenced files from an unpacked PPTX directory")
    p_clean.add_argument("unpacked_dir", help="Path to unpacked PPTX directory")
    p_clean.set_defaults(func=_cmd_clean)

    p_add = subs.add_parser("add", help="Duplicate a slide or create one from a layout")
    p_add.add_argument("unpacked_dir", help="Path to unpacked PPTX directory")
    p_add.add_argument("source", help="slide2.xml to duplicate, or slideLayout2.xml to create from layout")
    p_add.set_defaults(func=_cmd_add)

    p_thumb = subs.add_parser("thumbnail", help="Create a visual grid of slide thumbnails")
    p_thumb.add_argument("input", help="Input PowerPoint file (.pptx)")
    p_thumb.add_argument("output_prefix", nargs="?", default="thumbnails", help="Output prefix (default: thumbnails)")
    p_thumb.add_argument("--cols", type=int, default=COLS_DEFAULT, help=f"Number of columns (default: {COLS_DEFAULT})")
    p_thumb.set_defaults(func=_cmd_thumbnail)

    return parser


if __name__ == "__main__":
    parsed = build_parser().parse_args()
    parsed.func(parsed)

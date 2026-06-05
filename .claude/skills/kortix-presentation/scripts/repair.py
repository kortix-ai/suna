"""Repair known pptxgenjs OOXML issues in a PPTX file.

pptxgenjs emits defects that make PowerPoint show a "repair" dialog and that
the schema validator (office/validate.py) does NOT auto-fix:
  - Phantom slideMaster entries in [Content_Types].xml (pptxgenjs #1444)
  - ZIP directory entries (violate the Open Packaging Convention)
  - <p:presentation> child elements emitted out of OOXML schema order
    (e.g. notesMasterIdLst placed after sldIdLst) — fails strict ISO validation

Run this immediately after writeFile(), before office/validate.py.

Usage:
    python scripts/repair.py presentation.pptx
"""

import re
import shutil
import sys
import zipfile
from pathlib import Path

PHANTOM_MASTER_RE = re.compile(rb'<Override\s+PartName="/ppt/slideMasters/slideMaster(\d+)\.xml"[^>]*/>')

PRESENTATION_PART = "ppt/presentation.xml"

# CT_Presentation child order per ECMA-376 / ISO-IEC 29500. pptxgenjs emits a few
# of these out of order; reordering makes the part schema-valid.
CT_PRESENTATION_ORDER = [
    "sldMasterIdLst", "notesMasterIdLst", "handoutMasterIdLst", "sldIdLst",
    "sldSz", "notesSz", "smartTags", "embeddedFontLst", "custShowLst",
    "photoAlbum", "custDataLst", "kinsoku", "defaultTextStyle",
    "modifyVerifier", "extLst",
]


def _reorder_presentation(data):
    """Return reordered presentation.xml bytes, or None if unchanged / lxml absent."""
    try:
        from lxml import etree
    except ImportError:
        print("Warning: lxml not available — skipping presentation.xml reorder", file=sys.stderr)
        return None
    root = etree.fromstring(data)
    rank = {name: i for i, name in enumerate(CT_PRESENTATION_ORDER)}
    children = list(root)
    before = [etree.QName(c).localname for c in children]
    ordered = sorted(children, key=lambda e: rank.get(etree.QName(e).localname, len(rank)))
    after = [etree.QName(c).localname for c in ordered]
    if before == after:
        return None
    root[:] = ordered
    return etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)


def repair(filename):
    src = Path(filename)
    if not src.exists():
        print(f"Error: {src} not found", file=sys.stderr)
        return False

    actual_ids = set()
    has_dir_entries = False

    with zipfile.ZipFile(src, "r") as zf:
        for name in zf.namelist():
            if name.endswith("/"):
                has_dir_entries = True
            m = re.match(r"ppt/slideMasters/slideMaster(\d+)\.xml$", name)
            if m:
                actual_ids.add(int(m.group(1)))

        ct_data = zf.read("[Content_Types].xml")
        ct_fixed = PHANTOM_MASTER_RE.sub(
            lambda m: m.group(0) if int(m.group(1).decode()) in actual_ids else b"",
            ct_data,
        )
        ct_fixed = re.sub(rb"\n\s*\n", b"\n", ct_fixed)
        has_phantoms = ct_fixed != ct_data

        pres_fixed = None
        if PRESENTATION_PART in zf.namelist():
            pres_fixed = _reorder_presentation(zf.read(PRESENTATION_PART))

        if not has_dir_entries and not has_phantoms and pres_fixed is None:
            print(f"No repairs needed for {src.name}")
            return True

        tmp = str(src) + ".tmp"
        fixes = 0
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
            for item in zf.infolist():
                if item.filename.endswith("/"):
                    fixes += 1
                    continue
                if item.filename == "[Content_Types].xml":
                    data = ct_fixed
                elif item.filename == PRESENTATION_PART and pres_fixed is not None:
                    data = pres_fixed
                else:
                    data = zf.read(item.filename)
                zout.writestr(item, data)

    if has_phantoms:
        fixes += len(PHANTOM_MASTER_RE.findall(ct_data)) - len(PHANTOM_MASTER_RE.findall(ct_fixed))
    if pres_fixed is not None:
        fixes += 1

    try:
        shutil.move(tmp, str(src))
    except Exception:
        Path(tmp).unlink(missing_ok=True)
        raise
    print(f"Repaired {src.name}: {fixes} fixes applied")
    return True


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python repair.py <pptx_file>", file=sys.stderr)
        sys.exit(1)
    if not repair(sys.argv[1]):
        sys.exit(1)

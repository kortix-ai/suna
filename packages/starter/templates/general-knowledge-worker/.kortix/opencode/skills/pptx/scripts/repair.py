"""Repair known pptxgenjs OOXML issues in a PPTX file.

Fixes issues that cause PowerPoint to show "cannot read" or "repair" dialogs:
  - Phantom slideMaster entries in [Content_Types].xml (pptxgenjs #1444)
  - ZIP directory entries (violate Open Packaging Convention)

Usage:
    python skills/pptx/scripts/repair.py presentation.pptx
"""

import re
import shutil
import sys
import zipfile
from pathlib import Path

PHANTOM_MASTER_RE = re.compile(rb'<Override\s+PartName="/ppt/slideMasters/slideMaster(\d+)\.xml"[^>]*/>')


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

        if not has_dir_entries and not has_phantoms:
            print(f"No repairs needed for {src.name}")
            return True

        tmp = str(src) + ".tmp"
        fixes = 0
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
            for item in zf.infolist():
                if item.filename.endswith("/"):
                    fixes += 1
                    continue
                data = ct_fixed if item.filename == "[Content_Types].xml" else zf.read(item.filename)
                zout.writestr(item, data)

    if has_phantoms:
        fixes += len(PHANTOM_MASTER_RE.findall(ct_data)) - len(PHANTOM_MASTER_RE.findall(ct_fixed))

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

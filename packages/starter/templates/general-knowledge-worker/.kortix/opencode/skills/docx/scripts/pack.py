"""Repack an unpacked DOCX directory into a .docx file.

Condenses XML whitespace and assembles the ZIP archive. Validation is
handled server-side when the file is shared.

Usage:
    python pack.py <unpacked_dir> <output.docx>
    python pack.py working/ output.docx
"""

import shutil
import sys
import tempfile
import zipfile
from pathlib import Path

from lxml import etree

TEXT_TAG_SUFFIXES = ("}t", "}delText", "}instrText", "}delInstrText")


def pack_docx(input_directory: str, output_file: str) -> tuple[Path | None, str]:
    src = Path(input_directory)
    dst = Path(output_file)

    if not src.is_dir():
        return None, f"Error: {src} is not a directory"
    if dst.suffix.lower() != ".docx":
        return None, f"Error: {output_file} must be a .docx file"

    with tempfile.TemporaryDirectory() as td:
        staging = Path(td) / "staging"
        shutil.copytree(src, staging)

        for xml_file in list(staging.rglob("*.xml")) + list(staging.rglob("*.rels")):
            _strip_xml_whitespace(xml_file)

        dst.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zf:
            for f in staging.rglob("*"):
                if f.is_file():
                    zf.write(f, f.relative_to(staging))

    return dst, f"Packed {src} to {output_file}"


def _strip_xml_whitespace(xml_file: Path) -> None:
    try:
        tree = etree.parse(str(xml_file))
        for elem in tree.iter():
            if not isinstance(elem.tag, str):
                continue
            if any(elem.tag.endswith(s) for s in TEXT_TAG_SUFFIXES) or elem.tag in (
                "t",
                "delText",
                "instrText",
                "delInstrText",
            ):
                continue
            if elem.text and not elem.text.strip():
                elem.text = None
            for child in list(elem):
                if callable(child.tag):
                    elem.remove(child)
                    continue
                if child.tail and not child.tail.strip():
                    child.tail = None
        xml_file.write_bytes(etree.tostring(tree, xml_declaration=True, encoding="UTF-8"))
    except Exception as e:
        print(f"ERROR: Failed to process {xml_file.name}: {e}", file=sys.stderr)
        raise


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(description="Repack a directory into a DOCX file")
    ap.add_argument("input_directory", help="Unpacked DOCX directory")
    ap.add_argument("output_file", help="Output .docx file path")
    args = ap.parse_args()

    _, message = pack_docx(args.input_directory, args.output_file)
    print(message)
    if "Error" in message:
        sys.exit(1)

"""Expand a PPTX file into an editable directory of pretty-printed XML.

Extracts the ZIP contents, formats all XML with consistent indentation,
and normalizes curly quotation marks to XML entities.

Usage:
    python unpack.py <pptx_file> <output_dir>
    python unpack.py slides.pptx working/
"""

import re
import sys
import zipfile
from dataclasses import dataclass
from pathlib import Path

from lxml import etree

SMART_QUOTES = re.compile("[\u201c\u201d\u2018\u2019]")
QUOTE_ENTITY_MAP = {
    "\u201c": "&#x201C;",
    "\u201d": "&#x201D;",
    "\u2018": "&#x2018;",
    "\u2019": "&#x2019;",
}


@dataclass
class ExtractionResult:
    xml_count: int


def extract_pptx(
    pptx_path: str,
    dest_dir: str,
) -> tuple[ExtractionResult | None, str]:
    source = Path(pptx_path)
    target = Path(dest_dir)

    if not source.exists():
        return None, f"Error: {pptx_path} does not exist"
    if source.suffix.lower() != ".pptx":
        return None, f"Error: {pptx_path} is not a .pptx file"

    try:
        target.mkdir(parents=True, exist_ok=True)

        with zipfile.ZipFile(source, "r") as archive:
            archive.extractall(target)

        xml_paths = list(target.rglob("*.xml")) + list(target.rglob("*.rels"))

        for p in xml_paths:
            _prettify_xml(p)

        for p in xml_paths:
            _escape_smart_quotes(p)

        msg = f"Unpacked {pptx_path} ({len(xml_paths)} XML files)"
        return ExtractionResult(xml_count=len(xml_paths)), msg

    except zipfile.BadZipFile:
        return None, f"Error: {pptx_path} is not a valid ZIP archive"


def _prettify_xml(path: Path) -> None:
    try:
        doc = etree.parse(str(path))
        etree.indent(doc, space="  ")
        path.write_bytes(etree.tostring(doc, xml_declaration=True, encoding="UTF-8", pretty_print=True))
    except Exception:
        pass


def _escape_smart_quotes(path: Path) -> None:
    try:
        content = path.read_text(encoding="utf-8")
        if not SMART_QUOTES.search(content):
            return
        replaced = SMART_QUOTES.sub(lambda m: QUOTE_ENTITY_MAP[m.group()], content)
        path.write_text(replaced, encoding="utf-8")
    except Exception:
        pass


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Unpack a PPTX file for XML editing")
    parser.add_argument("pptx_file", help="PPTX file to extract")
    parser.add_argument("output_dir", help="Directory to extract into")
    args = parser.parse_args()

    _, output = extract_pptx(args.pptx_file, args.output_dir)
    print(output)
    if "Error" in output:
        sys.exit(1)

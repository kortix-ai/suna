"""Reassemble an unpacked PPTX directory into a .pptx file.

Strips formatting whitespace from XML, preserving text content in DrawingML
text elements, then compresses everything into a ZIP archive.

Usage:
    python pack.py <unpacked_dir> <output.pptx>
    python pack.py working/ presentation.pptx
"""

import shutil
import sys
import tempfile
import zipfile
from pathlib import Path

from lxml import etree

PROTECTED_TAG_ENDINGS = ("}t",)


def assemble_pptx(source_dir: str, output_path: str) -> tuple[Path | None, str]:
    root = Path(source_dir)
    dest = Path(output_path)

    if not root.is_dir():
        return None, f"Error: {root} is not a directory"
    if dest.suffix.lower() != ".pptx":
        return None, f"Error: {output_path} must be a .pptx file"

    with tempfile.TemporaryDirectory() as tmpdir:
        work = Path(tmpdir) / "content"
        shutil.copytree(root, work)

        for xml_path in list(work.rglob("*.xml")) + list(work.rglob("*.rels")):
            _condense_xml(xml_path)

        dest.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as zf:
            for entry in work.rglob("*"):
                if entry.is_file():
                    zf.write(entry, entry.relative_to(work))

    return dest, f"Packed {source_dir} to {output_path}"


def _condense_xml(filepath: Path) -> None:
    try:
        doc = etree.parse(str(filepath))
        for node in doc.iter():
            if not isinstance(node.tag, str):
                continue
            if any(node.tag.endswith(suffix) for suffix in PROTECTED_TAG_ENDINGS) or node.tag == "t":
                continue
            if node.text and not node.text.strip():
                node.text = None
            for child in list(node):
                if callable(child.tag):
                    node.remove(child)
                    continue
                if child.tail and not child.tail.strip():
                    child.tail = None
        filepath.write_bytes(etree.tostring(doc, xml_declaration=True, encoding="UTF-8"))
    except Exception as exc:
        print(f"ERROR: Failed to process {filepath.name}: {exc}", file=sys.stderr)
        raise


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Repack a directory into a PPTX file")
    parser.add_argument("unpacked_dir", help="Directory with unpacked PPTX contents")
    parser.add_argument("output_file", help="Output .pptx file path")
    args = parser.parse_args()

    _, output = assemble_pptx(args.unpacked_dir, args.output_file)
    print(output)
    if "Error" in output:
        sys.exit(1)

"""Extract a DOCX file into a directory of human-readable XML.

Pipeline: unzip → indent XML → coalesce tracked changes → merge runs → escape curly quotes.

Each post-processing step operates directly on document.xml in the output directory.
Run coalescing and merging can be disabled independently via CLI flags.

Usage:
    python unpack.py <docx_file> <output_dir>
    python unpack.py document.docx working/
    python unpack.py document.docx working/ --merge-runs false
    python unpack.py document.docx working/ --coalesce-changes false
"""

import re
import sys
import zipfile
from dataclasses import dataclass
from itertools import groupby
from pathlib import Path

from lxml import etree

WORDPROCESSINGML_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
AUTHOR_ATTR = f"{{{WORDPROCESSINGML_NS}}}author"
TAG_RUN = f"{{{WORDPROCESSINGML_NS}}}r"
TAG_RPR = f"{{{WORDPROCESSINGML_NS}}}rPr"
TAG_TEXT = f"{{{WORDPROCESSINGML_NS}}}t"
TAG_PROOF_ERR = f"{{{WORDPROCESSINGML_NS}}}proofErr"
XML_SPACE_ATTR = "{http://www.w3.org/XML/1998/namespace}space"

CURLY_QUOTE_PATTERN = re.compile("[\u201c\u201d\u2018\u2019]")
CURLY_QUOTE_ENTITIES = {
    "\u201c": "&#x201C;",
    "\u201d": "&#x201D;",
    "\u2018": "&#x2018;",
    "\u2019": "&#x2019;",
}


@dataclass
class UnpackResult:
    xml_count: int
    runs_merged: int
    changes_coalesced: int


def unpack_docx(
    input_file: str,
    output_directory: str,
    merge_runs: bool = True,
    coalesce_changes: bool = True,
) -> tuple[UnpackResult | None, str]:
    src = Path(input_file)
    dst = Path(output_directory)

    if not src.exists():
        return None, f"Error: {input_file} does not exist"
    if src.suffix.lower() != ".docx":
        return None, f"Error: {input_file} is not a .docx file"

    try:
        dst.mkdir(parents=True, exist_ok=True)

        with zipfile.ZipFile(src, "r") as zf:
            zf.extractall(dst)

        xml_files = list(dst.rglob("*.xml")) + list(dst.rglob("*.rels"))
        for xf in xml_files:
            _indent_xml(xf)

        runs_merged = 0
        changes_coalesced = 0

        doc_xml = dst / "word" / "document.xml"
        if doc_xml.exists():
            if coalesce_changes:
                changes_coalesced = _coalesce_tracked_changes(doc_xml)
            if merge_runs:
                runs_merged = _merge_adjacent_runs(doc_xml)

        for xf in xml_files:
            _replace_curly_quotes(xf)

        parts = [f"Unpacked {input_file} ({len(xml_files)} XML files"]
        if changes_coalesced:
            parts.append(f"coalesced {changes_coalesced} tracked changes")
        if runs_merged:
            parts.append(f"merged {runs_merged} runs")
        summary = ", ".join(parts) + ")"

        return UnpackResult(len(xml_files), runs_merged, changes_coalesced), summary

    except zipfile.BadZipFile:
        return None, f"Error: {input_file} is not a valid ZIP archive"


def _indent_xml(xml_file: Path) -> None:
    try:
        tree = etree.parse(str(xml_file))
        etree.indent(tree, space="  ")
        xml_file.write_bytes(etree.tostring(tree, xml_declaration=True, encoding="UTF-8", pretty_print=True))
    except Exception:
        pass


def _replace_curly_quotes(xml_file: Path) -> None:
    try:
        raw = xml_file.read_text(encoding="utf-8")
        if not CURLY_QUOTE_PATTERN.search(raw):
            return
        xml_file.write_text(
            CURLY_QUOTE_PATTERN.sub(lambda m: CURLY_QUOTE_ENTITIES[m.group()], raw),
            encoding="utf-8",
        )
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Run merging: consolidate adjacent <w:r> elements with identical <w:rPr>
# ---------------------------------------------------------------------------


def _merge_adjacent_runs(doc_xml: Path) -> int:
    if not doc_xml.exists():
        return 0
    tree = etree.parse(str(doc_xml))
    root = tree.getroot()

    for elem in list(root.iter(TAG_PROOF_ERR)):
        elem.getparent().remove(elem)

    for run in root.iter(TAG_RUN):
        for k in [a for a in run.attrib if "rsid" in a.lower()]:
            del run.attrib[k]

    seen: set[int] = set()
    containers: list[etree._Element] = []
    for run in root.iter(TAG_RUN):
        parent = run.getparent()
        pid = id(parent)
        if pid not in seen:
            seen.add(pid)
            containers.append(parent)

    total = sum(_merge_runs_in(c) for c in containers)
    if total > 0:
        doc_xml.write_bytes(etree.tostring(tree, xml_declaration=True, encoding="UTF-8", standalone=True))
    return total


def _canonical_rpr(run_elem: etree._Element) -> str | None:
    rpr = run_elem.find(TAG_RPR)
    if rpr is None:
        return None
    return etree.tostring(rpr, method="c14n2").decode()


def _merge_runs_in(container: etree._Element) -> int:
    groups: list[list[etree._Element]] = []
    active: list[etree._Element] = []
    active_sig: str | None = None

    for child in container:
        if child.tag != TAG_RUN:
            if active:
                groups.append(active)
                active = []
                active_sig = None
            continue
        sig = _canonical_rpr(child)
        if active and sig == active_sig:
            active.append(child)
        else:
            if active:
                groups.append(active)
            active = [child]
            active_sig = sig
    if active:
        groups.append(active)

    absorbed = 0
    for group in groups:
        if len(group) < 2:
            continue
        anchor = group[0]
        for donor in group[1:]:
            for node in list(donor):
                if node.tag != TAG_RPR:
                    anchor.append(node)
            container.remove(donor)
            absorbed += 1
        _join_adjacent_text(anchor)
    return absorbed


def _join_adjacent_text(run: etree._Element) -> None:
    children = list(run)
    idx = 0
    while idx < len(children) - 1:
        cur, nxt = children[idx], children[idx + 1]
        if cur.tag == TAG_TEXT and nxt.tag == TAG_TEXT:
            merged = (cur.text or "") + (nxt.text or "")
            cur.text = merged
            if merged.startswith(" ") or merged.endswith(" "):
                cur.set(XML_SPACE_ATTR, "preserve")
            elif XML_SPACE_ATTR in cur.attrib:
                del cur.attrib[XML_SPACE_ATTR]
            run.remove(nxt)
            children.pop(idx + 1)
        else:
            idx += 1


# ---------------------------------------------------------------------------
# Tracked-change coalescing: merge adjacent ins/del from the same author
# ---------------------------------------------------------------------------


def _coalesce_tracked_changes(doc_xml: Path) -> int:
    if not doc_xml.exists():
        return 0
    raw = doc_xml.read_bytes()
    root = etree.fromstring(raw, parser=etree.XMLParser(remove_blank_text=False))

    p_xpath = f".//{{{WORDPROCESSINGML_NS}}}p"
    tc_xpath = f".//{{{WORDPROCESSINGML_NS}}}tc"
    containers = root.findall(p_xpath) + root.findall(tc_xpath)

    reduction = 0
    for container in containers:
        for change_type in ("ins", "del"):
            reduction += _coalesce_in(container, change_type)

    if reduction > 0:
        doc_xml.write_bytes(etree.tostring(root, xml_declaration=True, encoding="UTF-8"))
    return reduction


def _coalesce_in(container: etree._Element, change_type: str) -> int:
    tag = f"{{{WORDPROCESSINGML_NS}}}{change_type}"
    matching = [ch for ch in container if ch.tag == tag]
    if len(matching) < 2:
        return 0

    total = 0
    for _author, run_iter in groupby(matching, key=lambda e: e.get(AUTHOR_ATTR, "")):
        total += _merge_change_run(list(run_iter))
    return total


def _merge_change_run(elements: list[etree._Element]) -> int:
    if len(elements) < 2:
        return 0
    absorbed = 0
    anchor = elements[0]
    for later in elements[1:]:
        if _changes_adjacent(anchor, later):
            for child in list(later):
                anchor.append(child)
            parent = later.getparent()
            if parent is not None:
                if later.tail:
                    prev = later.getprevious()
                    if prev is not None:
                        prev.tail = (prev.tail or "") + later.tail
                    else:
                        parent.text = (parent.text or "") + later.tail
                parent.remove(later)
            absorbed += 1
        else:
            anchor = later
    return absorbed


def _changes_adjacent(a: etree._Element, b: etree._Element) -> bool:
    parent = a.getparent()
    if parent is None:
        return False
    children = list(parent)
    try:
        pos_a, pos_b = children.index(a), children.index(b)
    except ValueError:
        return False
    text_between = a.tail or ""
    for mid in children[pos_a + 1 : pos_b]:
        if mid.tag is not etree.Comment:
            return False
        text_between += mid.tail or ""
    return text_between.strip() == ""


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(description="Unpack a DOCX file for XML editing")
    ap.add_argument("input_file", help="DOCX file to unpack")
    ap.add_argument("output_directory", help="Destination directory")
    ap.add_argument(
        "--merge-runs",
        type=lambda x: x.lower() == "true",
        default=True,
        metavar="true|false",
        help="Merge adjacent runs with identical formatting (default: true)",
    )
    ap.add_argument(
        "--coalesce-changes",
        type=lambda x: x.lower() == "true",
        default=True,
        metavar="true|false",
        help="Coalesce consecutive tracked changes from same author (default: true)",
    )
    args = ap.parse_args()

    _, message = unpack_docx(
        args.input_file,
        args.output_directory,
        merge_runs=args.merge_runs,
        coalesce_changes=args.coalesce_changes,
    )
    print(message)
    if "Error" in message:
        sys.exit(1)

#!/usr/bin/env python3
"""Annotate a PPTX with review issues as classic comments.

Usage:
    python annotate_pptx.py input.pptx output.pptx

Reads issues from document_review_state.json in the working directory.
Adds comments via XML manipulation (commentAuthors.xml +
per-slide comment files + Content_Types + relationships).
"""

import json
import os
import re
import shutil
import sys
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from xml.etree import ElementTree as ET

from constants import STATE_FILENAME
from models import DocumentIssue, format_comment

AUTHOR_NAME = "Kortix"
AUTHOR_INITIALS = "PPLX"

NS_PRES = "http://schemas.openxmlformats.org/presentationml/2006/main"
NS_REL = "http://schemas.openxmlformats.org/package/2006/relationships"
NS_CT = "http://schemas.openxmlformats.org/package/2006/content-types"
REL_TYPE_AUTHORS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/commentAuthors"
REL_TYPE_COMMENTS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments"
CT_AUTHORS = "application/vnd.openxmlformats-officedocument.presentationml.commentAuthors+xml"
CT_COMMENTS = "application/vnd.openxmlformats-officedocument.presentationml.comments+xml"

ET.register_namespace("", NS_REL)
ET.register_namespace("p", NS_PRES)


def load_issues() -> list[DocumentIssue]:
    """Load issues from document_review_state.json."""
    path = Path(STATE_FILENAME)
    if not path.exists():
        print(
            f"Error: {STATE_FILENAME} not found.",
            file=sys.stderr,
        )
        sys.exit(1)
    state = json.loads(path.read_text(encoding="utf-8"))
    return list(state.get("issues", {}).values())


def group_by_slide(issues: list[DocumentIssue]) -> dict[int, list[DocumentIssue]]:
    """Group issues by location parsed as slide number (1-based)."""
    grouped: dict[int, list[DocumentIssue]] = {}
    for issue in issues:
        try:
            slide = int(issue["location"])
        except (ValueError, TypeError):
            continue
        grouped.setdefault(slide, []).append(issue)
    return grouped


def find_max_rel_id(rels_path: Path) -> int:
    """Find the highest rId number in a .rels file."""
    if not rels_path.exists():
        return 0
    tree = ET.parse(rels_path)
    root = tree.getroot()
    max_id = 0
    for rel in root:
        rid = rel.get("Id", "")
        match = re.search(r"(\d+)", rid)
        if match:
            max_id = max(max_id, int(match.group(1)))
    return max_id


def add_relationship(rels_path: Path, rel_type: str, target: str) -> None:
    """Add a relationship to a .rels file, creating if needed."""
    if rels_path.exists():
        tree = ET.parse(rels_path)
        root = tree.getroot()
    else:
        rels_path.parent.mkdir(parents=True, exist_ok=True)
        root = ET.Element(f"{{{NS_REL}}}Relationships")
        tree = ET.ElementTree(root)

    for rel in root:
        if rel.get("Type") == rel_type:
            return

    next_id = find_max_rel_id(rels_path) + 1
    ET.SubElement(
        root,
        f"{{{NS_REL}}}Relationship",
        Id=f"rId{next_id}",
        Type=rel_type,
        Target=target,
    )
    ET.register_namespace("", NS_REL)
    tree.write(
        rels_path,
        xml_declaration=True,
        encoding="UTF-8",
    )


def write_slide_comments(tmp: Path, grouped: dict[int, list[DocumentIssue]]) -> int:
    """Create comment XML files and slide relationships.

    Returns the total comment count across all slides.
    """
    comments_dir = tmp / "ppt" / "comments"
    comments_dir.mkdir(parents=True, exist_ok=True)
    comment_idx = 0

    for slide_num, slide_issues in sorted(grouped.items()):
        now = datetime.now(timezone.utc).isoformat()
        cm_list = ET.Element("p:cmLst")
        cm_list.set("xmlns:p", NS_PRES)

        for issue in slide_issues:
            comment_idx += 1
            cm = ET.SubElement(
                cm_list,
                "p:cm",
                authorId="0",
                dt=now,
                idx=str(comment_idx),
            )
            ET.SubElement(cm, "p:pos", x="0", y="0")
            text_el = ET.SubElement(cm, "p:text")
            text_el.text = format_comment(issue)

        comment_file = comments_dir / f"comment{slide_num}.xml"
        ET.ElementTree(cm_list).write(
            comment_file,
            xml_declaration=True,
            encoding="UTF-8",
        )

        slide_rels_dir = tmp / "ppt" / "slides" / "_rels"
        slide_rels_dir.mkdir(parents=True, exist_ok=True)
        slide_rels = slide_rels_dir / f"slide{slide_num}.xml.rels"
        add_relationship(
            slide_rels,
            REL_TYPE_COMMENTS,
            f"../comments/comment{slide_num}.xml",
        )

    return comment_idx


def write_author_and_rels(tmp: Path, comment_idx: int, grouped: dict[int, list[DocumentIssue]]) -> None:
    """Write commentAuthors.xml, presentation rels, and content types."""
    author_el = ET.Element("p:cmAuthorLst")
    author_el.set("xmlns:p", NS_PRES)
    ET.SubElement(
        author_el,
        "p:cmAuthor",
        id="0",
        name=AUTHOR_NAME,
        initials=AUTHOR_INITIALS,
        lastIdx=str(comment_idx),
        clrIdx="0",
    )
    author_path = tmp / "ppt" / "commentAuthors.xml"
    ET.ElementTree(author_el).write(
        author_path,
        xml_declaration=True,
        encoding="UTF-8",
    )

    pres_rels = tmp / "ppt" / "_rels" / "presentation.xml.rels"
    add_relationship(
        pres_rels,
        REL_TYPE_AUTHORS,
        "commentAuthors.xml",
    )

    ct_path = tmp / "[Content_Types].xml"
    ct_tree = ET.parse(ct_path)
    ct_root = ct_tree.getroot()
    existing_parts = {el.get("PartName") for el in ct_root}
    if "/ppt/commentAuthors.xml" not in existing_parts:
        ET.SubElement(
            ct_root,
            f"{{{NS_CT}}}Override",
            PartName="/ppt/commentAuthors.xml",
            ContentType=CT_AUTHORS,
        )
    for slide_num in grouped:
        part = f"/ppt/comments/comment{slide_num}.xml"
        if part not in existing_parts:
            ET.SubElement(
                ct_root,
                f"{{{NS_CT}}}Override",
                PartName=part,
                ContentType=CT_COMMENTS,
            )
    ET.register_namespace("", NS_CT)
    ct_tree.write(
        ct_path,
        xml_declaration=True,
        encoding="UTF-8",
    )


def annotate(input_path: str, output_path: str) -> None:
    """Add comment annotations to the PPTX."""
    issues = load_issues()
    if not issues:
        print("No issues to annotate.")
        return

    grouped = group_by_slide(issues)
    shutil.copy2(input_path, output_path)

    tmpdir = tempfile.mkdtemp()
    try:
        with zipfile.ZipFile(output_path, "r") as zf:
            zf.extractall(tmpdir)

        tmp = Path(tmpdir)
        comment_idx = write_slide_comments(tmp, grouped)
        write_author_and_rels(tmp, comment_idx, grouped)

        with zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for root_dir, _dirs, files in os.walk(tmpdir):
                for filename in files:
                    file_path = os.path.join(root_dir, filename)
                    arcname = os.path.relpath(file_path, tmpdir)
                    zf.write(file_path, arcname)

        print(f"Added {comment_idx} comments to {output_path}")

    finally:
        shutil.rmtree(tmpdir)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(
            "Usage: annotate_pptx.py <input.pptx> <output.pptx>",
            file=sys.stderr,
        )
        sys.exit(1)
    annotate(sys.argv[1], sys.argv[2])

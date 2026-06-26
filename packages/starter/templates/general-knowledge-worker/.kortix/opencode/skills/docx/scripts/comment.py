"""Insert comments into an unpacked DOCX directory.

Handles the multi-file boilerplate: comments.xml, commentsExtended.xml,
commentsIds.xml, commentsExtensible.xml, plus relationships and content types.

Usage:
    python comment.py <unpacked_dir> <comment_id> <text>
    python comment.py <unpacked_dir> <comment_id> <text> --parent <parent_id>
    python comment.py <unpacked_dir> <comment_id> <text> --author "Jane Smith"

Text must be pre-escaped XML (e.g., &amp; for &, &#x2019; for smart apostrophe).

After running, insert markers into document.xml (see printed instructions).
"""

import random
import shutil
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from lxml import etree

TEMPLATE_DIR = Path(__file__).parent / "templates"

WML_MAIN = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
WML_2010 = "http://schemas.microsoft.com/office/word/2010/wordml"
WML_2012 = "http://schemas.microsoft.com/office/word/2012/wordml"
WML_2016_CID = "http://schemas.microsoft.com/office/word/2016/wordml/cid"
WML_2018_CEX = "http://schemas.microsoft.com/office/word/2018/wordml/cex"
RELATIONSHIPS_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
CONTENT_TYPES_NS = "http://schemas.openxmlformats.org/package/2006/content-types"

NSMAP = {
    "w": WML_MAIN,
    "w14": WML_2010,
    "w15": WML_2012,
    "w16cid": WML_2016_CID,
    "w16cex": WML_2018_CEX,
}

COMMENT_FILE_CONFIGS = [
    {
        "filename": "comments.xml",
        "root_tag": f"{{{WML_MAIN}}}comments",
        "rel_type": "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments",
        "content_type": "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml",
    },
    {
        "filename": "commentsExtended.xml",
        "root_tag": f"{{{WML_2012}}}commentsEx",
        "rel_type": "http://schemas.microsoft.com/office/2011/relationships/commentsExtended",
        "content_type": "application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml",
    },
    {
        "filename": "commentsIds.xml",
        "root_tag": f"{{{WML_2016_CID}}}commentsIds",
        "rel_type": "http://schemas.microsoft.com/office/2016/09/relationships/commentsIds",
        "content_type": "application/vnd.openxmlformats-officedocument.wordprocessingml.commentsIds+xml",
    },
    {
        "filename": "commentsExtensible.xml",
        "root_tag": f"{{{WML_2018_CEX}}}commentsExtensible",
        "rel_type": "http://schemas.microsoft.com/office/2018/08/relationships/commentsExtensible",
        "content_type": "application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtensible+xml",
    },
]

CURLY_QUOTE_MAP = {
    "\u201c": "&#x201C;",
    "\u201d": "&#x201D;",
    "\u2018": "&#x2018;",
    "\u2019": "&#x2019;",
}

DEFAULT_AUTHOR = "Kortix"
DEFAULT_INITIALS = "P"


@dataclass
class CommentSpec:
    comment_id: int
    text: str
    author: str = DEFAULT_AUTHOR
    initials: str = DEFAULT_INITIALS
    parent_id: int | None = None


def _make_hex_tag() -> str:
    return f"{random.randint(0, 0x7FFFFFFE):08X}"


def _escape_curly_quotes(raw: str) -> str:
    for ch, ent in CURLY_QUOTE_MAP.items():
        raw = raw.replace(ch, ent)
    return raw


def _parse_xml_file(filepath: Path) -> etree._Element:
    return etree.fromstring(filepath.read_bytes())


def _serialize_xml(root: etree._Element) -> bytes:
    raw = etree.tostring(root, xml_declaration=True, encoding="UTF-8")
    return _escape_curly_quotes(raw.decode("utf-8")).encode("utf-8")


def _build_comment_element(
    cid: int,
    author_name: str,
    author_initials: str,
    timestamp: str,
    paragraph_hex: str,
    body_text: str,
) -> etree._Element:
    comment_el = etree.Element(
        f"{{{WML_MAIN}}}comment",
        {
            f"{{{WML_MAIN}}}id": str(cid),
            f"{{{WML_MAIN}}}author": author_name,
            f"{{{WML_MAIN}}}date": timestamp,
            f"{{{WML_MAIN}}}initials": author_initials,
        },
    )

    para_el = etree.SubElement(
        comment_el,
        f"{{{WML_MAIN}}}p",
        {
            f"{{{WML_2010}}}paraId": paragraph_hex,
            f"{{{WML_2010}}}textId": "77777777",
        },
    )

    ref_run = etree.SubElement(para_el, f"{{{WML_MAIN}}}r")
    ref_rpr = etree.SubElement(ref_run, f"{{{WML_MAIN}}}rPr")
    etree.SubElement(ref_rpr, f"{{{WML_MAIN}}}rStyle", {f"{{{WML_MAIN}}}val": "CommentReference"})
    etree.SubElement(ref_run, f"{{{WML_MAIN}}}annotationRef")

    text_run = etree.SubElement(para_el, f"{{{WML_MAIN}}}r")
    text_rpr = etree.SubElement(text_run, f"{{{WML_MAIN}}}rPr")
    etree.SubElement(text_rpr, f"{{{WML_MAIN}}}color", {f"{{{WML_MAIN}}}val": "000000"})
    etree.SubElement(text_rpr, f"{{{WML_MAIN}}}sz", {f"{{{WML_MAIN}}}val": "20"})
    etree.SubElement(text_rpr, f"{{{WML_MAIN}}}szCs", {f"{{{WML_MAIN}}}val": "20"})
    wt = etree.SubElement(text_run, f"{{{WML_MAIN}}}t")
    wt.text = body_text

    return comment_el


def _build_extended_element(paragraph_hex: str, parent_para_hex: str | None) -> etree._Element:
    attrs = {
        f"{{{WML_2012}}}paraId": paragraph_hex,
        f"{{{WML_2012}}}done": "0",
    }
    if parent_para_hex is not None:
        attrs[f"{{{WML_2012}}}paraIdParent"] = parent_para_hex
    return etree.Element(f"{{{WML_2012}}}commentEx", attrs)


def _build_ids_element(paragraph_hex: str, durable_hex: str) -> etree._Element:
    return etree.Element(
        f"{{{WML_2016_CID}}}commentId",
        {
            f"{{{WML_2016_CID}}}paraId": paragraph_hex,
            f"{{{WML_2016_CID}}}durableId": durable_hex,
        },
    )


def _build_extensible_element(durable_hex: str, timestamp: str) -> etree._Element:
    return etree.Element(
        f"{{{WML_2018_CEX}}}commentExtensible",
        {
            f"{{{WML_2018_CEX}}}durableId": durable_hex,
            f"{{{WML_2018_CEX}}}dateUtc": timestamp,
        },
    )


def _resolve_parent_paragraph(comments_path: Path, parent_cid: int) -> str | None:
    tree_root = _parse_xml_file(comments_path)
    for node in tree_root.iter(f"{{{WML_MAIN}}}comment"):
        if node.get(f"{{{WML_MAIN}}}id") == str(parent_cid):
            for p_node in node.iter(f"{{{WML_MAIN}}}p"):
                hex_val = p_node.get(f"{{{WML_2010}}}paraId")
                if hex_val:
                    return hex_val
    return None


def _append_element_to_file(filepath: Path, child: etree._Element) -> None:
    tree_root = _parse_xml_file(filepath)
    tree_root.append(child)
    filepath.write_bytes(_serialize_xml(tree_root))


def _ensure_registrations(base_dir: Path) -> None:
    rels_file = base_dir / "word" / "_rels" / "document.xml.rels"
    ct_file = base_dir / "[Content_Types].xml"

    if rels_file.exists():
        rels_root = _parse_xml_file(rels_file)
        existing_targets = {el.get("Target") for el in rels_root.iter(f"{{{RELATIONSHIPS_NS}}}Relationship")}
        if "comments.xml" not in existing_targets:
            all_rids = []
            for el in rels_root.iter(f"{{{RELATIONSHIPS_NS}}}Relationship"):
                rid_str = el.get("Id", "")
                if rid_str.startswith("rId"):
                    try:
                        all_rids.append(int(rid_str[3:]))
                    except ValueError:
                        pass
            next_rid = (max(all_rids) if all_rids else 0) + 1

            for cfg in COMMENT_FILE_CONFIGS:
                etree.SubElement(
                    rels_root,
                    f"{{{RELATIONSHIPS_NS}}}Relationship",
                    {
                        "Id": f"rId{next_rid}",
                        "Type": cfg["rel_type"],
                        "Target": cfg["filename"],
                    },
                )
                next_rid += 1
            rels_file.write_bytes(etree.tostring(rels_root, xml_declaration=True, encoding="UTF-8"))

    if ct_file.exists():
        ct_root = _parse_xml_file(ct_file)
        existing_parts = {el.get("PartName") for el in ct_root.iter(f"{{{CONTENT_TYPES_NS}}}Override")}
        if "/word/comments.xml" not in existing_parts:
            for cfg in COMMENT_FILE_CONFIGS:
                etree.SubElement(
                    ct_root,
                    f"{{{CONTENT_TYPES_NS}}}Override",
                    {
                        "PartName": f"/word/{cfg['filename']}",
                        "ContentType": cfg["content_type"],
                    },
                )
            ct_file.write_bytes(etree.tostring(ct_root, xml_declaration=True, encoding="UTF-8"))


def insert_comment(unpacked_dir: str, spec: CommentSpec) -> tuple[str, str]:
    word_path = Path(unpacked_dir) / "word"
    if not word_path.exists():
        return "", f"Error: {word_path} not found"

    paragraph_hex = _make_hex_tag()
    durable_hex = _make_hex_tag()
    utc_stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    comments_file = word_path / "comments.xml"
    is_first = not comments_file.exists()
    if is_first:
        for cfg in COMMENT_FILE_CONFIGS:
            tpl = TEMPLATE_DIR / cfg["filename"]
            dest = word_path / cfg["filename"]
            if not dest.exists():
                shutil.copy(tpl, dest)
        _ensure_registrations(Path(unpacked_dir))

    comment_node = _build_comment_element(
        spec.comment_id,
        spec.author,
        spec.initials,
        utc_stamp,
        paragraph_hex,
        spec.text,
    )
    _append_element_to_file(comments_file, comment_node)

    parent_para_hex = None
    if spec.parent_id is not None:
        parent_para_hex = _resolve_parent_paragraph(comments_file, spec.parent_id)
        if not parent_para_hex:
            return "", f"Error: Parent comment {spec.parent_id} not found"

    extended_node = _build_extended_element(paragraph_hex, parent_para_hex)
    _append_element_to_file(word_path / "commentsExtended.xml", extended_node)

    ids_node = _build_ids_element(paragraph_hex, durable_hex)
    _append_element_to_file(word_path / "commentsIds.xml", ids_node)

    extensible_node = _build_extensible_element(durable_hex, utc_stamp)
    _append_element_to_file(word_path / "commentsExtensible.xml", extensible_node)

    label = "reply" if spec.parent_id is not None else "comment"
    return paragraph_hex, f"Added {label} {spec.comment_id} (para_id={paragraph_hex})"


MARKER_INSTRUCTIONS = """
Place these elements in document.xml around the text you want annotated.
Markers sit at the w:p level alongside w:r elements, not nested within them:
  <w:commentRangeStart w:id="{cid}"/>
  <w:r>...</w:r>
  <w:commentRangeEnd w:id="{cid}"/>
  <w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="{cid}"/></w:r>"""

REPLY_MARKER_INSTRUCTIONS = """
For a threaded reply, wrap markers inside the parent's range.
Markers sit at the w:p level alongside w:r elements, not nested within them:
  <w:commentRangeStart w:id="{pid}"/><w:commentRangeStart w:id="{cid}"/>
  <w:r>...</w:r>
  <w:commentRangeEnd w:id="{cid}"/><w:commentRangeEnd w:id="{pid}"/>
  <w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="{pid}"/></w:r>
  <w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="{cid}"/></w:r>"""


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(description="Insert comments into an unpacked DOCX")
    ap.add_argument("unpacked_dir", help="Path to unpacked DOCX directory")
    ap.add_argument("comment_id", type=int, help="Unique comment ID")
    ap.add_argument("text", help="Comment text (pre-escaped XML)")
    ap.add_argument("--author", default=DEFAULT_AUTHOR, help="Author name")
    ap.add_argument("--initials", default=DEFAULT_INITIALS, help="Author initials")
    ap.add_argument("--parent", type=int, help="Parent comment ID for threading")
    args = ap.parse_args()

    spec = CommentSpec(
        comment_id=args.comment_id,
        text=args.text,
        author=args.author,
        initials=args.initials,
        parent_id=args.parent,
    )
    paragraph_hex, msg = insert_comment(args.unpacked_dir, spec)
    print(msg)
    if "Error" in msg:
        sys.exit(1)

    if args.parent is not None:
        print(REPLY_MARKER_INSTRUCTIONS.format(pid=args.parent, cid=args.comment_id))
    else:
        print(MARKER_INSTRUCTIONS.format(cid=args.comment_id))

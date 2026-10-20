"""Tracked-change redlines in DOCX: each edit becomes w:del + w:ins by "Lumen", with a comment.

A PDF or TXT source has no DOCX to mark up, so the redline goes against a
converted copy: a new DOCX written from the document's anchored text.
"""
import copy
import datetime
import os

from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn

from .core import KitError, load_doc, normalize

AUTHOR = "Lumen"
_ids = iter(range(1000, 10**6))


def _run(text: str, deleted: bool = False, rpr=None):
    r = OxmlElement("w:r")
    if rpr is not None:
        r.append(copy.deepcopy(rpr))
    t = OxmlElement("w:delText" if deleted else "w:t")
    t.set(qn("xml:space"), "preserve")
    t.text = text
    r.append(t)
    return r


def _change(tag: str, run):
    el = OxmlElement(tag)
    el.set(qn("w:id"), str(next(_ids)))
    el.set(qn("w:author"), AUTHOR)
    el.set(qn("w:date"), datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
    el.append(run)
    return el


def _find(paragraphs, needle: str):
    """(paragraph, text, start, length) of the first paragraph whose text holds `needle` (raw, then normalized)."""
    for p in paragraphs:
        i = p.text.find(needle)
        if i >= 0:
            return p, p.text, i, len(needle)
    n = normalize(needle)
    for p in paragraphs:
        t = normalize(p.text)
        i = t.find(n)
        if i >= 0:
            return p, t, i, len(n)
    return None


def converted_copy(doc_id: str) -> Document:
    doc = Document()
    for para in load_doc(doc_id)["paras"]:
        doc.add_paragraph(para["text"])
    return doc


def redline(src: str | None, edits: list[dict], out: str, doc_id: str | None = None) -> dict:
    if src and src.lower().endswith(".docx"):
        doc = Document(src)
    elif doc_id:
        doc = converted_copy(doc_id)
    else:
        raise KitError("a .docx source or --doc is required")
    applied, missing = 0, []
    for e in edits:
        frm, to = e.get("from", ""), e.get("to", "")
        hit = _find(doc.paragraphs, frm) if frm else None
        if not hit:
            missing.append(e.get("a") or frm[:40])
            continue
        p, text, i, length = hit
        frm_text = text[i: i + length]
        # ponytail: the paragraph is rebuilt as plain runs with the first run's formatting, so a second
        # edit in the same paragraph replaces the first. One edit per paragraph is the playbook norm.
        rpr = p.runs[0]._r.find(qn("w:rPr")) if p.runs else None
        for r in list(p._p.iter(qn("w:r"))):
            r.getparent().remove(r)
        start, end = OxmlElement("w:commentRangeStart"), OxmlElement("w:commentRangeEnd")
        parts = [_run(text[:i], rpr=rpr), start, _change("w:del", _run(frm_text, True, rpr))]
        if to:
            parts.append(_change("w:ins", _run(to, rpr=rpr)))
        parts += [end, _run(text[i + len(frm_text):], rpr=rpr)]
        if e.get("comment"):
            c = doc.comments.add_comment(text=e["comment"], author=AUTHOR, initials="L")
            for el in (start, end):
                el.set(qn("w:id"), str(c.comment_id))
            ref_run = OxmlElement("w:r")
            ref = OxmlElement("w:commentReference")
            ref.set(qn("w:id"), str(c.comment_id))
            ref_run.append(ref)
            parts.insert(parts.index(end) + 1, ref_run)
        else:
            parts.remove(start)
            parts.remove(end)
        for el in parts:
            p._p.append(el)
        applied += 1
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    doc.save(out)
    return {"ok": not missing, "applied": applied, "missing": missing, **verify(out)}


def verify(path: str) -> dict:
    doc = Document(path)
    body = doc.element.body
    return {
        "insertions": len(body.findall(".//" + qn("w:ins"))),
        "deletions": len(body.findall(".//" + qn("w:del"))),
        "comments": len(list(doc.comments)),
    }

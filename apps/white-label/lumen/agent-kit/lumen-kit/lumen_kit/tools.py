"""Run results (validated, atomic), drafts (pandoc + house style) and OCR (pdftoppm + tesseract)."""
import glob
import json
import os
import re
import subprocess
import tempfile

from .core import KitError, check_citation, walk_citations
from .validate import errors

RESULT_DIR = "out"


def _atomic_write(path: str, data: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".tmp-")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(data)
    os.replace(tmp, path)


def result_errors(schema_name: str, value) -> list[str]:
    """Schema errors, plus the rules a schema cannot say: citations must check out, and a
    review cell needs one unless it is not_found."""
    out = errors(value, {"$ref": schema_name})
    if out:
        return out
    if schema_name == "review-row":
        for key, cell in value["cells"].items():
            if not cell.get("not_found") and not cell["citations"]:
                out.append(f"$.cells.{key}: a found value needs at least one citation")
    for i, c in enumerate(walk_citations(value)):
        r = check_citation(c)
        if not r["ok"]:
            hint = f" (the quote is in {r['fixed_anchor']})" if r.get("fixed_anchor") else ""
            out.append(f"citation {i} {c.get('doc_id')}#{c.get('a')}: {r['code']}{hint}")
    return out


def result_write(batch: str, schema_name: str, out_name: str, value) -> dict:
    if not re.fullmatch(r"[A-Za-z0-9_./-]{1,120}", out_name) or ".." in out_name or out_name.startswith("/"):
        raise KitError(f"bad --out {out_name!r}: a relative path inside out/")
    if not out_name.endswith(".json"):
        raise KitError("--out must end in .json")
    if not isinstance(value, dict) or str(value.get("schema", "")).split("/")[0] != schema_name:
        raise KitError(f'the result needs "schema": "{schema_name}/1"')
    errs = result_errors(schema_name, value)
    if errs:
        return {"ok": False, "errors": errs}
    path = os.path.join(batch, RESULT_DIR, out_name)
    _atomic_write(path, json.dumps(value, ensure_ascii=False, indent=1))
    return {"ok": True, "path": path}


def result_done(batch: str, status: str, error: str | None = None) -> dict:
    outputs = sorted(os.path.relpath(p, batch) for p in glob.glob(os.path.join(batch, RESULT_DIR, "**", "*"), recursive=True) if os.path.isfile(p))
    if status == "succeeded":
        bad = []
        for rel in outputs:
            if not rel.endswith(".json"):
                continue
            with open(os.path.join(batch, rel), encoding="utf-8") as f:
                value = json.load(f)
            name = str(value.get("schema", "")).split("/")[0] if isinstance(value, dict) else ""
            errs = result_errors(name, value) if name else ['no "schema" field: write results with `lumen result write`']
            if errs:
                bad.append({"file": rel, "errors": errs})
        if bad:
            return {"ok": False, "errors": bad}
    done = {"status": status, "outputs": outputs, **({"error": error[:1000]} if error else {})}
    _atomic_write(os.path.join(batch, "done.json"), json.dumps(done))
    return {"ok": True, **done}


_CLAUSE = re.compile(r"\n(?=\d+(?:\.\d+)+\s)")
_MARKER = re.compile(r"\[\[CONFIRM: (\w+)\]\]")


def clause_paragraphs(md: str) -> str:
    """One paragraph per numbered clause: a "3.2 ..." line after a single newline gets a blank line before it."""
    return re.sub(r"(?<!\n)" + _CLAUSE.pattern, "\n\n", md)


def marker_label(field: str) -> str:
    """governing_law -> "[Governing law - to confirm]", the text a lawyer reads in Word."""
    return f"[{field.replace('_', ' ').capitalize()} \u2014 to confirm]"


def _pandoc(md_out: str, out: str, md: str) -> None:
    try:
        subprocess.run(["pandoc", md_out, "-o", out], check=True, capture_output=True)
    except FileNotFoundError:
        _docx_from_markdown(md, out)
    _house_style(out)


def _house_style(out: str) -> None:
    """Legal house style on the delivered .docx: serif text, black headings, highlighted [to confirm] fields."""
    from docx import Document
    from docx.enum.text import WD_COLOR_INDEX
    from docx.oxml.ns import qn
    from docx.shared import Pt, RGBColor

    doc = Document(out)
    for st in doc.styles:
        font = getattr(st, "font", None)
        if font is None:
            continue
        font.name = "Times New Roman"
        rpr = st.element.get_or_add_rPr()
        fonts = rpr.get_or_add_rFonts()
        fonts.set(qn("w:eastAsia"), "Times New Roman")
        for theme in ("w:asciiTheme", "w:hAnsiTheme", "w:eastAsiaTheme", "w:cstheme"):
            fonts.attrib.pop(qn(theme), None)  # a theme font (pandoc's headings) wins over a named one
        font.color.rgb = RGBColor(0, 0, 0)
        if st.name.startswith("Heading") or st.name == "Title":
            font.bold = True
            font.italic = False
            font.size = Pt({"Title": 16, "Heading 1": 14, "Heading 2": 12}.get(st.name, 11))
        elif st.name in ("Normal", "Body Text", "First Paragraph", "Compact"):
            font.size = Pt(11)
    for p in doc.paragraphs:
        for run in list(p.runs):
            parts = _MARKER.split(run.text)
            if len(parts) == 1:
                continue
            run.text = parts[0]
            anchor = run._r
            for i, part in enumerate(parts[1:]):
                if not part:
                    continue
                new = p.add_run(marker_label(part) if i % 2 == 0 else part)
                new._r.getparent().remove(new._r)
                if run._r.rPr is not None:
                    from copy import deepcopy
                    new._r.insert(0, deepcopy(run._r.rPr))
                if i % 2 == 0:
                    new.font.highlight_color = WD_COLOR_INDEX.YELLOW
                anchor.addnext(new._r)
                anchor = new._r
    doc.save(out)


def draft_render(template: str, fields: dict, out: str) -> dict:
    with open(template, encoding="utf-8") as f:
        md = f.read()
    unfilled = []

    def fill(m):
        v = fields.get(m.group(1))
        if v in (None, ""):
            unfilled.append(m.group(1))
            return f"[[CONFIRM: {m.group(1)}]]"
        return str(v)

    md = clause_paragraphs(re.sub(r"\{\{\s*(\w+)\s*\}\}", fill, md))
    md_out = os.path.splitext(out)[0] + ".md"
    _atomic_write(md_out, md)
    _pandoc(md_out, out, md)
    return {"ok": True, "docx": out, "markdown": md_out, "unfilled": unfilled}


_CITE = re.compile(r"\[([^\]]*)\]\(/cite\?d=([^&)]+)&a=p(\d+)\.\d+[^)]*\)")


def report_docx(batch: str) -> dict:
    """out/report.json -> out/report.md + out/report.docx. A citation link becomes "(filename, p. N)"."""
    with open(os.path.join(batch, "input.json"), encoding="utf-8") as f:
        names = {d["doc_id"]: d["filename"] for d in json.load(f).get("documents", [])}
    with open(os.path.join(batch, "out", "report.json"), encoding="utf-8") as f:
        report = json.load(f)

    def cite(m):
        return f"({names.get(m.group(2), 'document')}, p. {m.group(3)})"

    lines = ["# Due diligence report", ""]
    for s in report.get("sections", []):
        lines += [f"## {s['heading']}", "", _CITE.sub(cite, s["body_md"]).strip(), ""]
    flags = report.get("red_flags", [])
    if flags:
        lines += ["## Red flags", ""]
        for r in flags:
            lines += [f"**{r['severity'].upper()}**: {r['title']} ({names.get(r['doc_id'], 'document')})", ""]
    md = clause_paragraphs("\n".join(lines).strip() + "\n")
    md_out = os.path.join(batch, "out", "report.md")
    out = os.path.join(batch, "out", "report.docx")
    _atomic_write(md_out, md)
    _pandoc(md_out, out, md)
    return {"ok": True, "docx": out, "markdown": md_out}


def _docx_from_markdown(md: str, out: str) -> None:
    """Headings, numbered clauses and paragraphs, for an image without pandoc. **bold** spans stay bold."""
    from docx import Document

    doc = Document()
    for block in re.split(r"\n\s*\n|\n(?=#)|\n(?=\d+(?:\.\d+)+\s)", md.strip()):
        line = block.strip()
        if not line:
            continue
        h = re.match(r"^(#{1,6})\s+(.*)$", line)
        if h:
            doc.add_heading(h.group(2).strip(), level=min(len(h.group(1)), 4))
            continue
        p = doc.add_paragraph()
        for i, part in enumerate(re.split(r"\*\*", line.replace("\n", " "))):
            p.add_run(part).bold = i % 2 == 1
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    doc.save(out)


def ocr(pdf: str, out: str, doc_id: str) -> dict:
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(["pdftoppm", "-r", "200", "-png", pdf, os.path.join(tmp, "p")], check=True, capture_output=True)
        pages = []
        for png in sorted(glob.glob(os.path.join(tmp, "p-*.png"))):
            r = subprocess.run(["tesseract", png, "-", "--psm", "3"], check=True, capture_output=True, text=True)
            pages.append(r.stdout.strip())
    body = "\n\n".join(f"<!-- lumen:ocr page={i} -->\n{t}" for i, t in enumerate(pages, 1))
    _atomic_write(out, f"<!-- lumen:ocr doc={doc_id} pages={len(pages)} -->\n{body}\n")
    return {"ok": True, "pages": len(pages), "out": out}

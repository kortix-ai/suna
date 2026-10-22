import argparse
import json
import urllib.parse
import sys

from . import core, redline, search, tools


def _json_arg(value: str | None, file: str | None):
    if file == "-" or (value is None and file is None):
        return json.load(sys.stdin)
    if file:
        with open(file, encoding="utf-8") as f:
            return json.load(f)
    return json.loads(value)


def build() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="lumen", description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("matter", help="this conversation's matter folder")

    s = sub.add_parser("docs", help="the documents of a matter")
    s.add_argument("--matter")

    s = sub.add_parser("read", help="anchored paragraphs of a document")
    s.add_argument("--doc", required=True)
    s.add_argument("--page", type=int)
    s.add_argument("--anchor")
    s.add_argument("--context", type=int, default=0)
    s.add_argument("--matter")

    s = sub.add_parser("search", help="BM25 paragraph search over a matter")
    s.add_argument("--matter")
    s.add_argument("--query", required=True)
    s.add_argument("--doc", action="append")
    s.add_argument("--k", type=int, default=8)

    s = sub.add_parser("cite", help="check citations: `lumen cite check --file c.json` or JSON on stdin")
    s.add_argument("action", choices=["check"])
    s.add_argument("--file")
    s.add_argument("--json")

    s = sub.add_parser("result", help="write a validated result file, or done.json")
    s.add_argument("action", choices=["write", "done"])
    s.add_argument("--batch", required=True, help="the batch folder named in input.json (batch_dir)")
    s.add_argument("--schema")
    s.add_argument("--out", help="file name inside out/, e.g. rows/<doc_id>.json")
    s.add_argument("--file")
    s.add_argument("--json")
    s.add_argument("--status", choices=["succeeded", "failed"])
    s.add_argument("--error")

    s = sub.add_parser("redline", help="tracked-change DOCX from edits [{a, from, to, comment}]")
    s.add_argument("action", nargs="?", choices=["verify"])
    s.add_argument("--docx")
    s.add_argument("--doc", help="doc id: redline a converted copy of a PDF or TXT")
    s.add_argument("--edits")
    s.add_argument("--out")

    s = sub.add_parser("draft", help="render a template to DOCX")
    s.add_argument("action", choices=["render"])
    s.add_argument("--template", required=True)
    s.add_argument("--fields", required=True, help="JSON object or @file.json")
    s.add_argument("--out", required=True)

    s = sub.add_parser("report", help="render out/report.json to out/report.docx (diligence)")
    s.add_argument("action", choices=["docx"])
    s.add_argument("--batch", required=True)

    s = sub.add_parser("ocr", help="OCR a scanned PDF into Text/<doc_id>.ocr.md")
    s.add_argument("--pdf", required=True)
    s.add_argument("--doc", required=True)
    s.add_argument("--out", required=True)
    return p


def run(a) -> dict:
    if getattr(a, "matter", None) is None and a.cmd in ("docs", "search", "read"):
        a.matter = core.current_matter()
        if a.matter is None and a.cmd != "read":
            raise core.KitError("--matter is required (no matter folder in this session)")
    if a.cmd == "matter":
        m = core.current_matter()
        if not m:
            raise core.KitError("this session has no matter folder; runs name it in input.json")
        return {"matter": m}
    if a.cmd == "docs":
        return {"docs": core.list_docs(a.matter)}
    if a.cmd == "read":
        return core.read(a.doc, a.page, a.anchor, a.context, a.matter)
    if a.cmd == "search":
        return search.search(a.matter, a.query, a.doc, a.k)
    if a.cmd == "cite":
        data = _json_arg(a.json, a.file)
        cites = data["citations"] if isinstance(data, dict) else data
        results = []
        for i, c in enumerate(cites):
            r = {"i": i, **core.check_citation(c)}
            if r["ok"]:
                # The exact chat link for this citation: paste it, never hand-encode one.
                q = urllib.parse.quote(str(c["quote"]), safe="")
                r["link"] = f"[{i + 1}](/cite?d={c['doc_id']}&a={c['a']}&q={q})"
            results.append(r)
        return {"ok": all(r["ok"] for r in results), "results": results}
    if a.cmd == "result":
        if a.action == "done":
            if not a.status:
                raise core.KitError("--status is required")
            return tools.result_done(a.batch, a.status, a.error)
        if not (a.schema and a.out):
            raise core.KitError("--schema and --out are required")
        return tools.result_write(a.batch, a.schema, a.out, _json_arg(a.json, a.file))
    if a.cmd == "redline":
        if a.action == "verify":
            return redline.verify(a.docx)
        if not (a.out and a.edits):
            raise core.KitError("--edits and --out are required")
        edits = _json_arg(None, a.edits[1:]) if a.edits.startswith("@") else json.loads(a.edits)
        return redline.redline(a.docx, edits, a.out, a.doc)
    if a.cmd == "draft":
        fields = _json_arg(None, a.fields[1:]) if a.fields.startswith("@") else json.loads(a.fields)
        return tools.draft_render(a.template, fields, a.out)
    if a.cmd == "report":
        return tools.report_docx(a.batch)
    if a.cmd == "ocr":
        return tools.ocr(a.pdf, a.out, a.doc)
    raise core.KitError(f"unknown command {a.cmd}")


def main(argv: list[str]) -> int:
    try:
        a = build().parse_args(argv)
    except SystemExit as e:
        return 0 if e.code == 0 else 2
    try:
        out = run(a)
    except (core.KitError, KeyError, ValueError, OSError) as e:
        print(json.dumps({"ok": False, "error": str(e)}))
        return 2
    print(json.dumps(out, ensure_ascii=False))
    return 0 if out.get("ok", True) else 3

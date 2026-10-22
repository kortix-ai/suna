"""Documents, anchors and citation checks.

Lumen writes one `Text/<doc_id>.md` per document. A comment before every
paragraph names its anchor (`<!-- lumen:a p=3 n=12 -->` = anchor `p3.12`).
The kit reads these anchors and never segments a document itself, so a
citation from an agent and Lumen's own check address the same paragraph.
"""
import glob
import json
import os
import re
import unicodedata

# A firm session mounts its own firm folder at /drives/<firmId> (and the read-only kit at /drives/kit):
# the glob reaches that firm's matters only, because no other firm's folder is in the sandbox.
# A restricted matter's session mounts only that matter, at /drives/<matterId>.
DRIVE_ROOT = os.environ.get("LUMEN_DRIVE_ROOT", "/drives/*")
MAX_QUOTE = 300

_DOC = re.compile(r"<!-- lumen:doc (.*?) -->")
_ANCHOR = re.compile(r"<!-- lumen:a p=(\d+) n=(\d+)(?: h=\"(.*?)\")? -->")
_ATTR = re.compile(r'(\w+)=("([^"]*)"|\S+)')


def current_matter() -> str | None:
    """The matter folder of this conversation: `lumen_matter_dir` in the session context the workspace
    exposes as a JSON environment variable (the one whose name ends in _SESSION_CONTEXT)."""
    for k, v in os.environ.items():
        if k.endswith("_SESSION_CONTEXT"):
            try:
                return json.loads(v).get("lumen_matter_dir")
            except (ValueError, AttributeError):
                return None
    return None


class KitError(Exception):
    """A usage or data error: the CLI prints it as JSON and exits 2."""


def normalize(text: str) -> str:
    """The one normalization for quotes. shared/cite-vectors.json pins it; convex/lib/cite.ts mirrors it."""
    t = unicodedata.normalize("NFKC", text)
    t = t.replace("­", "")
    t = re.sub(r"(?<=\w)-[ \t]*\n\s*(?=\w)", "", t)
    t = re.sub("[‘’‚‛′]", "'", t)
    t = re.sub("[“”„‟″]", '"', t)
    t = re.sub("[‐‑‒–—―−]", "-", t)
    return re.sub(r"\s+", " ", t).strip()


def parse_text(md: str) -> dict:
    """{meta, paras: [{a, page, n, text, heading?}]} from a Text/<doc_id>.md file."""
    m = _DOC.search(md)
    meta = {k: (q if q is not None and v.startswith('"') else v) for k, v, q in _ATTR.findall(m.group(1))} if m else {}
    paras = []
    matches = list(_ANCHOR.finditer(md))
    for i, a in enumerate(matches):
        end = matches[i + 1].start() if i + 1 < len(matches) else len(md)
        text = md[a.end():end].strip()
        para = {"a": f"p{a.group(1)}.{a.group(2)}", "page": int(a.group(1)), "n": int(a.group(2)), "text": text}
        if a.group(3):
            para["heading"] = a.group(3)
        paras.append(para)
    return {"meta": meta, "paras": paras}


def text_path(doc_id: str, matter: str | None = None) -> str:
    """The Text file of a document: in the given matter, else in any matter (doc ids are unique)."""
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", doc_id or ""):
        raise KitError(f"bad doc id: {doc_id!r}")
    if matter:
        path = os.path.join(matter, "Text", f"{doc_id}.md")
        if os.path.exists(path):
            return path
    hits = glob.glob(os.path.join(DRIVE_ROOT, "Matters", "*", "Text", f"{doc_id}.md")) or glob.glob(
        os.path.join(DRIVE_ROOT, "Text", f"{doc_id}.md")
    )
    if not hits:
        raise KitError(f"unknown_doc: {doc_id}")
    return hits[0]


_cache: dict[str, dict] = {}


def load_doc(doc_id: str, matter: str | None = None) -> dict:
    if doc_id not in _cache:
        with open(text_path(doc_id, matter), encoding="utf-8") as f:
            _cache[doc_id] = parse_text(f.read())
    return _cache[doc_id]


def list_docs(matter: str) -> list[dict]:
    path = os.path.join(matter, "index.json")
    if not os.path.exists(path):
        raise KitError(f"no index.json in {matter}")
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def read(doc_id: str, page: int | None = None, anchor: str | None = None, context: int = 0, matter: str | None = None) -> dict:
    paras = load_doc(doc_id, matter)["paras"]
    if anchor:
        idx = next((i for i, p in enumerate(paras) if p["a"] == anchor), None)
        if idx is None:
            raise KitError(f"wrong_anchor: {anchor} is not in {doc_id}")
        paras = paras[max(0, idx - context): idx + context + 1]
    elif page is not None:
        paras = [p for p in paras if p["page"] == page]
    return {"doc_id": doc_id, "paras": [{k: p[k] for k in ("a", "page", "text", "heading") if k in p} for p in paras]}


def check_citation(c: dict, matter: str | None = None) -> dict:
    """{ok} or {ok: false, code, fixed_anchor?}. Codes: too_long, unknown_doc, not_found, wrong_anchor."""
    quote = normalize(str(c.get("quote", "")))
    if not quote:
        return {"ok": False, "code": "not_found"}
    if len(str(c.get("quote", ""))) > MAX_QUOTE:
        return {"ok": False, "code": "too_long"}
    try:
        paras = load_doc(str(c.get("doc_id", "")), matter)["paras"]
    except (KitError, OSError):
        return {"ok": False, "code": "unknown_doc"}
    for p in paras:
        if p["a"] == c.get("a") and quote in normalize(p["text"]):
            return {"ok": True}
    for p in paras:
        if quote in normalize(p["text"]):
            return {"ok": False, "code": "wrong_anchor", "fixed_anchor": p["a"]}
    return {"ok": False, "code": "not_found"}


def walk_citations(obj):
    """Every citation object inside a result (any dict with doc_id + a + quote)."""
    if isinstance(obj, dict):
        if {"doc_id", "a", "quote"} <= obj.keys():
            yield obj
        for v in obj.values():
            yield from walk_citations(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from walk_citations(v)

"""Paragraph search over a matter: SQLite FTS5 (BM25), one row per anchored paragraph.

The index lives in /tmp (never in the repo working tree) and is rebuilt when the
matter's set of Text files changes (path + size + mtime).
"""
import hashlib
import os
import re
import sqlite3
import tempfile

from .core import KitError, load_doc, list_docs, text_path


def _signature(paths: list[str]) -> str:
    h = hashlib.sha256()
    for p in sorted(paths):
        st = os.stat(p)
        h.update(f"{p}:{st.st_size}:{st.st_mtime_ns}".encode())
    return h.hexdigest()[:16]


def _index(matter: str, doc_ids: list[str]) -> sqlite3.Connection:
    paths = [text_path(d, matter) for d in doc_ids]
    db = os.path.join(tempfile.gettempdir(), f"lumen-index-{_signature(paths)}.sqlite")
    fresh = not os.path.exists(db)
    con = sqlite3.connect(db)
    if fresh:
        con.execute("create virtual table paras using fts5(doc_id unindexed, a unindexed, text, tokenize='porter unicode61')")
        for d in doc_ids:
            con.executemany("insert into paras values (?, ?, ?)", [(d, p["a"], p["text"]) for p in load_doc(d, matter)["paras"]])
        con.commit()
    return con


def search(matter: str, query: str, docs: list[str] | None = None, k: int = 8) -> dict:
    words = re.findall(r"\w+", query)
    if not words:
        raise KitError("empty query")
    ids = docs or [d["doc_id"] for d in list_docs(matter)]
    con = _index(matter, ids)
    # Any word matches; a word ending in * is a prefix ("indemnif*").
    terms = " OR ".join(f'"{w}"' + ("*" if query.find(w + "*") >= 0 else "") for w in words)
    where = "paras match ?"
    args: list = [terms]
    if docs:
        where += f" and doc_id in ({','.join('?' * len(docs))})"
        args += docs
    rows = con.execute(
        f"select doc_id, a, bm25(paras) as s, snippet(paras, 2, '[', ']', ' ... ', 24) from paras where {where} order by s limit ?",
        [*args, k],
    ).fetchall()
    return {"hits": [{"doc_id": d, "a": a, "score": round(-s, 3), "snippet": sn} for d, a, s, sn in rows]}

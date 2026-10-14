"""CI helper: compare a recorded library A with library B restored from the bucket.

Usage: python ci_sync_restore_compare.py <kortix-capture> <library A> <library B> <evidence dir>

Compares, over A's uploaded chunks: frames, OCR boxes, windows, app/domain/URL,
AX snapshots, chunk rows, segment membership and FTS index rows (as hashes), FTS hits for A's five most common
words through the real CLI, and the PNG export of three frames. Writes
<evidence>/sync_restore_compare.json with counts and hashes only (no screen
text) and exits 1 on any mismatch.
"""
import datetime
import collections
import hashlib
import json
import os
import pathlib
import re
import sqlite3
import subprocess
import sys

k, lib_a, lib_b, ev = sys.argv[1], sys.argv[2], sys.argv[3], pathlib.Path(sys.argv[4])
a, b = (sqlite3.connect(str(pathlib.Path(p) / "memory.db")) for p in (lib_a, lib_b))
digest = lambda rows: hashlib.sha256(json.dumps(rows, default=str).encode()).hexdigest()[:16]
UP = "f.video IN (SELECT id FROM video WHERE remote_key IS NOT NULL)"
TABLES = {
    "frames": f"SELECT f.timestamp, f.video_index, f.width, f.height, f.title, f.foreground, f.background FROM frame f WHERE {UP} ORDER BY 1",
    "ocr_boxes": f"SELECT f.timestamp, o.x, o.y, o.width, o.height, o.text_offset, o.text_length FROM ocr o JOIN frame f ON f.id = o.frame WHERE {UP} ORDER BY 1, 6, 2, 3",
    "windows": f"SELECT f.timestamp, a.bundle_id, w.window_title, w.x, w.y, w.width, w.height, w.z_order, w.is_focussed_window FROM window_bound w JOIN frame f ON f.id = w.frame JOIN application a ON a.id = w.application WHERE {UP} ORDER BY 1, 8",
    "app_domain_url": f"SELECT f.timestamp, a.bundle_id, d.normalized_domain, s.url FROM frame f LEFT JOIN segment s ON s.id = f.segment LEFT JOIN application a ON a.id = s.application LEFT JOIN domain d ON d.id = s.domain WHERE {UP} ORDER BY 1",
    "ax_snapshots": f"SELECT f.timestamp, s.bundle_id, s.node_count FROM ax_snapshot s JOIN frame f ON f.id = s.frame_id WHERE {UP} ORDER BY 1",
    "chunks": "SELECT start_timestamp, end_timestamp, num_frames, width, height FROM video WHERE remote_key IS NOT NULL ORDER BY 1",
    # Which frames share a segment: search collapses repeated text per segment.
    "segments": f"SELECT group_concat(timestamp) FROM (SELECT f.segment, f.timestamp FROM frame f WHERE {UP} ORDER BY f.timestamp) GROUP BY segment ORDER BY min(timestamp)",
    "fts_index_rows": f"SELECT count(*) FROM ocr_fts_docsize d JOIN frame f ON f.id = d.id WHERE {UP}",
}
out = {"checks": [], "a_chunks_not_uploaded": a.execute("SELECT count(*) FROM video WHERE remote_key IS NULL").fetchone()[0]}


def check(name, ra, rb):
    out["checks"].append({"name": name, "same": ra == rb, "a": [len(ra), digest(ra)], "b": [len(rb), digest(rb)]})


for name, sql in TABLES.items():
    check(name, a.execute(sql).fetchall(), b.execute(sql).fetchall())

words = collections.Counter(
    w.lower()
    for (t,) in a.execute(f"SELECT COALESCE(foreground, '') || ' ' || COALESCE(background, '') FROM frame f WHERE {UP}")
    for w in re.findall(r"[A-Za-z]{4,}", t)
)
# Search collapses repeated text per segment onto its newest frame. A segment that runs
# into the chunk still waiting for upload would pick a frame the restore cannot have, so
# both searches stop right after the last uploaded frame.
last_up = a.execute(f"SELECT max(f.timestamp) FROM frame f WHERE {UP}").fetchone()[0] or 0
before = datetime.datetime.fromtimestamp((last_up + 1000) // 1000).strftime("%Y-%m-%dT%H:%M:%S")
for i, (word, _) in enumerate(words.most_common(5)):
    hits = []
    for lib, conn in ((lib_a, a), (lib_b, b)):
        res = subprocess.run([k, "--json", "query", "fts", word, "--limit", "500", "--tr", f"before:{before}"], env={**os.environ, "KORTIX_CAPTURE_DIR": lib}, capture_output=True, text=True)
        up = {r[0] for r in conn.execute(f"SELECT f.id FROM frame f WHERE {UP}")}
        hits.append(sorted((h.get("timestamp"), h.get("application"), h.get("domain"), h.get("url"), h.get("ocr_text")) for h in json.loads(res.stdout or "[]") if h["frame_id"] in up))
    check(f"fts_q{i + 1}", hits[0], hits[1])

stamps = [r[0] for r in a.execute(f"SELECT f.timestamp FROM frame f WHERE {UP} ORDER BY 1")]
for ts in sorted({stamps[0], stamps[len(stamps) // 2], stamps[-1]} if stamps else set()):
    shas = []
    for lib, conn in ((lib_a, a), (lib_b, b)):
        fid = conn.execute("SELECT id FROM frame WHERE timestamp = ? AND video IS NOT NULL", (ts,)).fetchone()[0]
        res = subprocess.run([k, "query", "image", "--id", str(fid)], env={**os.environ, "KORTIX_CAPTURE_DIR": lib}, capture_output=True, text=True)
        path = (res.stdout.strip().splitlines() or [""])[-1]
        data = pathlib.Path(path).read_bytes() if path and pathlib.Path(path).is_file() else b""
        shas.append([len(data), hashlib.sha256(data).hexdigest()[:16]] if data else [0, res.stderr.strip()[:200]])
    out["checks"].append({"name": f"image_export_{stamps.index(ts)}", "same": shas[0] == shas[1] and shas[0][0] > 0, "a": shas[0], "b": shas[1]})

out["all_same"] = bool(out["checks"]) and all(c["same"] for c in out["checks"])
(ev / "sync_restore_compare.json").write_text(json.dumps(out, indent=2))
for c in out["checks"]:
    print(("SAME" if c["same"] else "DIFF"), c["name"], "A", c["a"], "B", c["b"])
print("ALL SAME" if out["all_same"] else "MISMATCH")
sys.exit(0 if out["all_same"] else 1)

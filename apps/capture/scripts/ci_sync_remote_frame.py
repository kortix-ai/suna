"""CI helper: write the id of the first frame whose chunk is remote-only (status 3).

Usage: python ci_sync_remote_frame.py <library dir> <evidence dir>
"""
import pathlib
import sqlite3
import sys

lib, ev = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
db = sqlite3.connect(f"file:{(lib / 'memory.db').as_posix()}?mode=ro", uri=True)
frame = db.execute(
    "SELECT min(id) FROM frame WHERE video = (SELECT min(id) FROM video WHERE status = 3)"
).fetchone()[0]
(ev / "sync_remote_frame.txt").write_text(str(frame or ""))
print("remote-only frame:", frame)

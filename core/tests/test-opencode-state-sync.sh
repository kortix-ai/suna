#!/usr/bin/env bash
set -euo pipefail

ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT

export KORTIX_PERSISTENT_ROOT="$ROOT/persistent"
export OPENCODE_STORAGE_BASE="$KORTIX_PERSISTENT_ROOT/opencode"
export OPENCODE_SHADOW_STORAGE_BASE="$KORTIX_PERSISTENT_ROOT/opencode-shadow"
export KORTIX_OPENCODE_ARCHIVE_DIR="$KORTIX_PERSISTENT_ROOT/opencode-archive"

mkdir -p "$OPENCODE_STORAGE_BASE"

python3 - <<'PY'
import os, sqlite3
db = sqlite3.connect(os.path.join(os.environ['OPENCODE_STORAGE_BASE'], 'opencode.db'))
db.executescript('''
CREATE TABLE session (id TEXT PRIMARY KEY, time_updated INTEGER);
CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL);
INSERT INTO session VALUES ('ses_live', 1000);
INSERT INTO message VALUES ('msg_live', 'ses_live');
''')
db.commit()
db.close()
PY

python3 core/scripts/kortix-opencode-state sync >/dev/null

python3 - <<'PY'
import json, os, subprocess
out = subprocess.check_output(['python3', 'core/scripts/kortix-opencode-state', 'status'], text=True)
data = json.loads(out)
assert data['shadow']['sessions'] == 1, data
assert data['shadow']['messages'] == 1, data
PY

python3 - <<'PY'
import os, sqlite3
db = sqlite3.connect(os.path.join(os.environ['OPENCODE_STORAGE_BASE'], 'opencode.db'))
db.execute('DELETE FROM message')
db.execute('DELETE FROM session')
db.commit()
db.close()
PY

python3 core/scripts/kortix-opencode-state guard >/dev/null

python3 - <<'PY'
import json, subprocess
out = subprocess.check_output(['python3', 'core/scripts/kortix-opencode-state', 'status'], text=True)
data = json.loads(out)
assert data['live']['sessions'] == 1, data
assert data['live']['messages'] == 1, data
PY

python3 - <<'PY'
import os, sqlite3
db = sqlite3.connect(os.path.join(os.environ['OPENCODE_STORAGE_BASE'], 'opencode.db'))
db.execute('DELETE FROM message')
db.commit()
db.close()
PY

python3 core/scripts/kortix-opencode-state guard >/dev/null

python3 - <<'PY'
import json, subprocess
out = subprocess.check_output(['python3', 'core/scripts/kortix-opencode-state', 'status'], text=True)
data = json.loads(out)
assert data['live']['sessions'] == 1, data
assert data['live']['messages'] == 1, data
assert data['live']['latest_session_update'] == 1000, data
PY

rm -rf "$OPENCODE_STORAGE_BASE" "$OPENCODE_SHADOW_STORAGE_BASE"
mkdir -p "$OPENCODE_STORAGE_BASE" "$OPENCODE_SHADOW_STORAGE_BASE"

python3 - <<'PY'
import os, sqlite3
from pathlib import Path

def make_db(root, session_id, updated, message_ids):
    db = sqlite3.connect(Path(root) / 'opencode.db')
    db.executescript('''
    CREATE TABLE session (id TEXT PRIMARY KEY, time_updated INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL);
    ''')
    db.execute('INSERT INTO session VALUES (?, ?)', (session_id, updated))
    for message_id in message_ids:
        db.execute('INSERT INTO message VALUES (?, ?)', (message_id, session_id))
    db.commit()
    db.close()

make_db(os.environ['OPENCODE_STORAGE_BASE'], 'ses_live_newer', 2000, ['msg_live_newer'])
make_db(os.environ['OPENCODE_SHADOW_STORAGE_BASE'], 'ses_shadow_old', 1000, ['msg_shadow_old_1', 'msg_shadow_old_2'])
PY

python3 core/scripts/kortix-opencode-state guard >/dev/null

python3 - <<'PY'
import json, subprocess
out = subprocess.check_output(['python3', 'core/scripts/kortix-opencode-state', 'status'], text=True)
data = json.loads(out)
assert data['live']['latest_session_update'] == 2000, data
assert data['live']['messages'] == 1, data
assert data['shadow']['latest_session_update'] == 2000, data
assert data['shadow']['messages'] == 1, data
PY

rm -rf "$OPENCODE_STORAGE_BASE" "$OPENCODE_SHADOW_STORAGE_BASE"
mkdir -p "$OPENCODE_STORAGE_BASE"

python3 - <<'PY'
import os, sqlite3
from pathlib import Path

db = sqlite3.connect(Path(os.environ['OPENCODE_STORAGE_BASE']) / 'opencode.db')
db.execute('PRAGMA journal_mode=WAL')
db.execute('PRAGMA wal_autocheckpoint=0')
db.executescript('''
CREATE TABLE session (id TEXT PRIMARY KEY, time_updated INTEGER);
CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL);
INSERT INTO session VALUES ('ses_wal_only', 3000);
INSERT INTO message VALUES ('msg_wal_only', 'ses_wal_only');
''')
db.commit()
os._exit(0)
PY

test -s "$OPENCODE_STORAGE_BASE/opencode.db-wal"
python3 core/scripts/kortix-opencode-state sync >/dev/null

python3 - <<'PY'
import json, os, subprocess
out = subprocess.check_output(['python3', 'core/scripts/kortix-opencode-state', 'status'], text=True)
data = json.loads(out)
assert data['shadow']['sessions'] == 1, data
assert data['shadow']['messages'] == 1, data
assert data['shadow']['latest_session_update'] == 3000, data
assert not os.path.exists(os.path.join(os.environ['OPENCODE_SHADOW_STORAGE_BASE'], 'opencode.db-wal')), data
PY

if grep -q 'name "\*.db-wal"' core/startup.sh; then
  echo "startup.sh must not delete SQLite WAL files"
  exit 1
fi

echo "opencode-state-sync ok"

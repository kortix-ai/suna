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

echo "opencode-state-sync ok"

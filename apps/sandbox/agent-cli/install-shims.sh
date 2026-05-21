#!/bin/bash
#
# install-shims.sh — generate /usr/local/bin shims for every agent CLI.
#
# Walks $ROOT (typically /opt/kortix/agent-cli) for *.ts files, skipping
# the shared lib/ dir. For each file, writes a tiny shell shim at
# /usr/local/bin/<basename> that execs bun on the source.
#
# Adding a new CLI: drop a .ts file in any category subdir (channels/,
# connectors/, …). Next image build picks it up. No Dockerfile change.
#
# Fails the build on basename collisions — two CLIs cannot share a name.

set -euo pipefail

ROOT="${1:-/opt/kortix/agent-cli}"
BIN_DIR="${BIN_DIR:-/usr/local/bin}"

if [[ ! -d "$ROOT" ]]; then
  echo "install-shims.sh: $ROOT does not exist" >&2
  exit 1
fi

# Avoid bash 4+ features (associative arrays) so the script also runs on
# macOS for local testing; use a newline-delimited "seen" string instead.
seen=""
count=0
installed_names=""

while IFS= read -r -d '' file; do
  name=$(basename "$file" .ts)
  if printf '%s\n' "$seen" | grep -qxF "$name"; then
    echo "install-shims.sh: name collision — multiple files would install as '$name'" >&2
    exit 1
  fi
  seen="$seen
$name"
  cat >"$BIN_DIR/$name" <<EOF
#!/bin/sh
exec bun $file "\$@"
EOF
  chmod +x "$BIN_DIR/$name"
  count=$((count + 1))
  installed_names="$installed_names $name"
done < <(find "$ROOT" -name '*.ts' -not -path "$ROOT/lib/*" -print0)

if [ "$count" -eq 0 ]; then
  echo "install-shims.sh: no CLIs found under $ROOT" >&2
  exit 1
fi

echo "install-shims.sh: installed $count CLI(s):$installed_names"

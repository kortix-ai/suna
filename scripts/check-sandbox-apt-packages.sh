#!/usr/bin/env bash
# Every apt package the sandbox image installs must exist in its base image's
# archive.
#
# The sandbox image (apps/sandbox/Dockerfile) is built on the sandbox provider
# after a merge, never on the pull request. On 2026-09-23 a substring scrub
# rewrote `build-essential` to `build-samplecol`; nothing on the pull request
# built the image, and every default image build failed for the next 16 hours:
# previews never became ready, and dev could not roll its sandbox image
# forward. This check resolves the runtime stage's package list against the
# same base image with `apt-get install --dry-run`: an unknown name exits 100.
#
#   bash scripts/check-sandbox-apt-packages.sh [path/to/Dockerfile]
set -euo pipefail

dockerfile="${1:-apps/sandbox/Dockerfile}"

# The runtime stage is the last `FROM ubuntu:`; its first `apt-get install`
# (continuation lines joined) holds the package list, up to the next `&&`.
read -r base packages < <(python3 - "$dockerfile" <<'PY'
import re, sys
text = open(sys.argv[1]).read().replace('\\\n', ' ')
stages = [m for m in re.finditer(r'^FROM\s+(ubuntu:\S+)', text, re.M)]
if not stages:
    sys.exit('no `FROM ubuntu:` stage')
stage = stages[-1]
body = text[stage.end():]
install = re.search(r'apt-get install\s+(.*?)(?:&&|$)', body, re.M)
if not install:
    sys.exit('no `apt-get install` in the ubuntu stage')
names = [token for token in install.group(1).split() if not token.startswith('-')]
if not names:
    sys.exit('empty package list')
print(stage.group(1), ' '.join(names))
PY
)

count=$(wc -w <<<"$packages" | tr -d ' ')
echo "resolving ${count} apt packages against ${base}"
# apt's working directories are tmpfs: the check writes nothing to the host
# disk, and runs on a runner whose Docker disk is nearly full.
docker run --rm \
  --tmpfs /var/lib/apt/lists:size=400m --tmpfs /var/cache/apt:size=400m --tmpfs /tmp:size=100m \
  "$base" bash -c \
  "apt-get update -qq >/dev/null && apt-get install --dry-run --no-install-recommends ${packages} >/dev/null"
echo "all ${count} packages resolve"

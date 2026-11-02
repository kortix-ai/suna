#!/usr/bin/env bash
# Carry the hashed `_next/static` files of earlier frontend builds into a new
# build, so a tab that still runs an earlier build can load its lazy chunks
# after the deploy.
#
# Why: a Next.js image holds only its own build's chunks. On the dev ECS web
# service, a deploy removes every chunk of the build before it. A tab opened
# before the deploy then fails its next lazy import with
# "Failed to load chunk /_next/static/chunks/<hash>.js" (2026-10-30: a dev tab
# on 26a25c5034 crashed 35 s after 61db0e7bdd rolled out). Vercel keeps old
# deployment assets; an ECS image does not, so the image carries them.
#
# Usage: carry-web-static.sh <static-dir> <keep-builds> <image>...
#   <static-dir>   the new build's `.next/static` (merged in place)
#   <keep-builds>  builds to keep, counting the new one (one build ≈ 20 MB)
#   <image>...     earlier frontend images to carry files from. A missing or
#                  unreadable image is skipped with a warning: the first build
#                  has nothing to carry, and a carry must never fail a deploy.
#
# The new build's files win (`cp --update=none`). Every file keeps its build-time mtime
# (docker cp and COPY preserve it), and one build writes its files within
# ~30 s of its `<buildId>/_buildManifest.js`. Files more than 10 min older than
# the oldest kept build's manifest belong to a dropped build and are deleted.
set -euo pipefail

static_dir="${1:?usage: carry-web-static.sh <static-dir> <keep-builds> <image>...}"
keep="${2:?usage: carry-web-static.sh <static-dir> <keep-builds> <image>...}"
shift 2
[ -d "$static_dir" ] || { echo "::error::$static_dir is not a directory" >&2; exit 1; }
[[ "$keep" =~ ^[1-9][0-9]*$ ]] || { echo "::error::keep-builds must be a positive integer" >&2; exit 1; }

IMAGE_STATIC=/app/apps/web/.next/static
MARGIN_SECONDS=600
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

before=$(find "$static_dir" -type f | wc -l)
for image in "$@"; do
  dest="$work/$(echo "$image" | tr '/:@' '___')"
  if [ -z "${CARRY_WEB_STATIC_FROM_DIR:-}" ]; then
    if ! container=$(docker create --platform linux/amd64 "$image" 2>/dev/null); then
      echo "::warning::carry-web-static: cannot read $image; nothing carried from it"
      continue
    fi
    mkdir -p "$dest"
    docker cp -q "$container:$IMAGE_STATIC" "$dest/" >/dev/null 2>&1 || echo "::warning::carry-web-static: $image has no $IMAGE_STATIC"
    docker rm "$container" >/dev/null
  else
    # Test seam: <image> names a directory under $CARRY_WEB_STATIC_FROM_DIR.
    if [ -d "$CARRY_WEB_STATIC_FROM_DIR/$image" ]; then
      mkdir -p "$dest" && cp -a "$CARRY_WEB_STATIC_FROM_DIR/$image" "$dest/static"
    else
      echo "::warning::carry-web-static: cannot read $image; nothing carried from it"
    fi
  fi
  if [ -d "$dest/static" ]; then cp -a --update=none "$dest/static/." "$static_dir/"; fi
done

merged=$(find "$static_dir" -type f | wc -l)

# Builds newest first, by the mtime of their build manifest.
mapfile -t manifests < <(find "$static_dir" -mindepth 2 -maxdepth 2 -name _buildManifest.js -printf '%T@ %p\n' | sort -rn)
dropped=0
if [ "${#manifests[@]}" -gt "$keep" ]; then
  oldest_kept="${manifests[$((keep - 1))]%% *}"
  cutoff=$(( ${oldest_kept%.*} - MARGIN_SECONDS ))
  dropped=$(find "$static_dir" -type f ! -newermt "@$cutoff" -print -delete | wc -l)
  find "$static_dir" -mindepth 1 -type d -empty -delete
fi

after=$(find "$static_dir" -type f | wc -l)
builds=$(find "$static_dir" -mindepth 2 -maxdepth 2 -name _buildManifest.js | wc -l)
echo "carry-web-static: $before own files, $((merged - before)) carried, $dropped dropped; $builds builds, $(du -sh "$static_dir" | cut -f1) in $static_dir"

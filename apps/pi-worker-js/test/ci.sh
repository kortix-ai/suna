#!/usr/bin/env bash
# THE WHOLE SWEEP ON A MACHINE THAT HAS NOTHING: CI, or a fresh laptop.
#
# all.sh assumes a MinIO named pt-minio and the pinned celld image already
# exist, because on the machines it grew up on they always did. This provides
# both, idempotently, from agent.config.json's local target, then runs all.sh.
# Suites that need what CI cannot have SKIP by name (a Platinum checkout, a
# dev token) — a skip is reported, never counted as a pass.
set -euo pipefail
cd "$(dirname "$0")/.."
T=$(node -e 'const c=require("./agent.config.json").targets.local; console.log([c.image,c.host_ports.minio,c.credentials.access_key,c.credentials.secret_key,c.bucket.replace(/^s3:\/\//,"").split("/")[0]].join(" "))')
read -r IMAGE MINIO_PORT ACCESS SECRET BUCKET <<<"$T"

docker version >/dev/null 2>&1 || { echo "  docker is not available"; exit 1; }
if ! docker inspect pt-minio >/dev/null 2>&1; then
  echo "  starting pt-minio on :${MINIO_PORT}"
  docker run -d --name pt-minio -p "${MINIO_PORT}:9000" -e MINIO_ROOT_USER="$ACCESS" -e MINIO_ROOT_PASSWORD="$SECRET" \
    quay.io/minio/minio server /data >/dev/null
fi
docker start pt-minio >/dev/null 2>&1 || true
for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:${MINIO_PORT}/minio/health/live" >/dev/null && break; sleep 0.5; done
docker run --rm --network host --entrypoint sh quay.io/minio/mc -c \
  "mc alias set m http://127.0.0.1:${MINIO_PORT} ${ACCESS} ${SECRET} >/dev/null 2>&1 && mc mb --ignore-existing m/${BUCKET} >/dev/null 2>&1" \
  || { echo "  could not create bucket ${BUCKET}"; exit 1; }
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "  building ${IMAGE} from Dockerfile.celld"
  docker build -q -f Dockerfile.celld -t "$IMAGE" . >/dev/null
fi
echo "  minio :${MINIO_PORT} bucket ${BUCKET}; image ${IMAGE}"
exec ./test/all.sh

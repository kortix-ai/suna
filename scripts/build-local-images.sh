#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TAG="latest"
INCLUDE_POSTGRES=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --tag)
      [ "$#" -ge 2 ] || { echo "--tag requires a value" >&2; exit 1; }
      TAG="$2"
      shift 2
      ;;
    --tag=*)
      TAG="${1#*=}"
      shift
      ;;
    --include-postgres)
      INCLUDE_POSTGRES=1
      shift
      ;;
    -h|--help)
      cat <<'EOF'
Usage: build-local-images.sh [options]

Options:
  --tag <tag>          Image tag to build (default: latest)
  --tag=<tag>          Same as above
  --include-postgres   Also build `kortix/postgres:<tag>`
EOF
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

command -v docker >/dev/null 2>&1 || { echo "docker is required" >&2; exit 1; }
command -v pnpm >/dev/null 2>&1 || { echo "pnpm is required" >&2; exit 1; }

printf "[build-local-images] Building frontend standalone output...\n"
(
  cd "$REPO_ROOT/apps/web"
  rm -rf .next
  NEXT_PUBLIC_ENV_MODE=local \
  NEXT_PUBLIC_BACKEND_URL=http://localhost:8008/v1 \
  NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co \
  NEXT_PUBLIC_SUPABASE_ANON_KEY=local-build-placeholder-anon-key \
  NEXT_OUTPUT=standalone \
  pnpm run build
)

printf "[build-local-images] Building kortix/kortix-frontend:%s...\n" "$TAG"
docker build --no-cache -f "$REPO_ROOT/apps/web/Dockerfile" -t "kortix/kortix-frontend:${TAG}" "$REPO_ROOT"

printf "[build-local-images] Building kortix/kortix-api:%s...\n" "$TAG"
docker build --build-arg SERVICE=apps/api -f "$REPO_ROOT/apps/api/Dockerfile" -t "kortix/kortix-api:${TAG}" "$REPO_ROOT"

printf "[build-local-images] Building kortix/sandbox:%s...\n" "$TAG"
docker build -f "$REPO_ROOT/apps/sandbox/Dockerfile" -t "kortix/sandbox:${TAG}" "$REPO_ROOT"

printf "[build-local-images] Local project sessions use the sandbox image through the local_docker provider.\n"

if [ "$INCLUDE_POSTGRES" = "1" ]; then
  printf "[build-local-images] Building kortix/postgres:%s...\n" "$TAG"
  docker build -f "$REPO_ROOT/services/postgres/Dockerfile" -t "kortix/postgres:${TAG}" "$REPO_ROOT/services/postgres"
fi

printf "[build-local-images] Done.\n"

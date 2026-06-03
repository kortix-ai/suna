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
  NEXT_PUBLIC_BILLING_ENABLED=false \
  NEXT_PUBLIC_BACKEND_URL=http://localhost:8008/v1 \
  NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co \
  NEXT_PUBLIC_SUPABASE_ANON_KEY=local-build-placeholder-anon-key \
  NEXT_OUTPUT=standalone \
  pnpm exec next build --experimental-app-only
)

printf "[build-local-images] Repairing frontend standalone Next package...\n"
(
  cd "$REPO_ROOT"
  STANDALONE_NEXT_PACKAGE=$(find apps/web/.next/standalone/node_modules/.pnpm -path '*/node_modules/next/package.json' -type f | sort | head -n 1)
  [ -n "$STANDALONE_NEXT_PACKAGE" ] || { echo "could not find standalone next package" >&2; exit 1; }
  WORKSPACE_NEXT_PACKAGE=$(node - "$REPO_ROOT/apps/web" <<'JS'
const { createRequire } = require('module');
const requireFromWeb = createRequire(`${process.argv[2]}/package.json`);
console.log(requireFromWeb.resolve('next/package.json'));
JS
  )
  [ -n "$WORKSPACE_NEXT_PACKAGE" ] || { echo "could not resolve workspace next package" >&2; exit 1; }
  STANDALONE_NEXT_DIR=$(dirname "$STANDALONE_NEXT_PACKAGE")
  WORKSPACE_NEXT_DIR=$(dirname "$WORKSPACE_NEXT_PACKAGE")
  cp -R "$WORKSPACE_NEXT_DIR/." "$STANDALONE_NEXT_DIR/"

  node - "$REPO_ROOT" <<'JS'
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const repoRoot = process.argv[2];
const requireFromWeb = createRequire(`${repoRoot}/apps/web/package.json`);
const pnpmRoot = path.join(repoRoot, 'node_modules/.pnpm');
const standalonePnpmRoot = path.join(repoRoot, 'apps/web/.next/standalone/node_modules/.pnpm');

function packageNameFromPackageJson(packageJsonPath) {
  const marker = `${path.sep}node_modules${path.sep}`;
  const markerIndex = packageJsonPath.lastIndexOf(marker);
  if (markerIndex === -1) return null;
  const packageDir = packageJsonPath.slice(0, markerIndex);
  const relative = path.relative(pnpmRoot, packageDir);
  if (relative.startsWith('..')) return null;
  return relative.split(path.sep)[0];
}

function packageNameFromResolvedPath(resolvedPath) {
  const relative = path.relative(pnpmRoot, resolvedPath);
  if (relative.startsWith('..')) return null;
  return relative.split(path.sep)[0];
}

const queue = [];
const shikiPackage = packageNameFromPackageJson(requireFromWeb.resolve('shiki/package.json'));
if (shikiPackage) queue.push(shikiPackage);

const copied = new Set();
while (queue.length > 0) {
  const packageName = queue.shift();
  if (!packageName || copied.has(packageName)) continue;
  copied.add(packageName);

  const sourceDir = path.join(pnpmRoot, packageName);
  const targetDir = path.join(standalonePnpmRoot, packageName);
  if (!fs.existsSync(sourceDir)) continue;
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.cpSync(sourceDir, targetDir, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
  });

  const stack = [sourceDir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        const target = path.resolve(path.dirname(entryPath), fs.readlinkSync(entryPath));
        const dependencyPackage = packageNameFromResolvedPath(target);
        if (dependencyPackage && !copied.has(dependencyPackage)) {
          queue.push(dependencyPackage);
        }
      } else if (entry.isDirectory()) {
        stack.push(entryPath);
      }
    }
  }
}
JS
)

printf "[build-local-images] Building kortix/kortix-frontend:%s...\n" "$TAG"
docker build --no-cache -f "$REPO_ROOT/apps/web/Dockerfile" -t "kortix/kortix-frontend:${TAG}" "$REPO_ROOT"

printf "[build-local-images] Building kortix/kortix-api:%s...\n" "$TAG"
docker build --build-arg SERVICE=apps/api -f "$REPO_ROOT/apps/api/Dockerfile" -t "kortix/kortix-api:${TAG}" "$REPO_ROOT"

printf "[build-local-images] Building kortix/kortix-sandbox:%s...\n" "$TAG"
docker build -f "$REPO_ROOT/apps/sandbox/Dockerfile" -t "kortix/kortix-sandbox:${TAG}" "$REPO_ROOT"

printf "[build-local-images] Local project sessions use the sandbox image through the local_docker provider.\n"

if [ "$INCLUDE_POSTGRES" = "1" ]; then
  printf "[build-local-images] Building kortix/postgres:%s...\n" "$TAG"
  docker build -f "$REPO_ROOT/services/postgres/Dockerfile" -t "kortix/postgres:${TAG}" "$REPO_ROOT/services/postgres"
fi

printf "[build-local-images] Done.\n"

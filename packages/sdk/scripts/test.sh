#!/usr/bin/env bash
# The @kortix/sdk unit suite: one bun process per test file, four at a time, so
# no mock.module state leaks between files. A path argument (a test file or a
# folder) narrows the run to the test files under it; any other argument, such
# as `-t <name>`, reaches every bun process. `pnpm --filter @kortix/sdk test
# <file>` used to append the file to every process, which ran the whole suite.
set -euo pipefail
cd "$(dirname "$0")/.."

paths=()
options=()
for arg in "$@"; do
  if [[ -e "$arg" ]]; then
    paths+=("$arg")
  elif [[ "$arg" == */* || "$arg" == *.test.ts || "$arg" == *.test.tsx ]]; then
    # A mistyped path must not fall back to the whole suite.
    echo "no such test path: $arg (paths are relative to packages/sdk)" >&2
    exit 2
  else
    options+=("$arg")
  fi
done
[[ ${#paths[@]} -gt 0 ]] || paths=(src)

files=$(find "${paths[@]}" \( -name '*.test.ts' -o -name '*.test.tsx' \) | sort)
if [[ -z "$files" ]]; then
  echo "no test files under: ${paths[*]}" >&2
  exit 2
fi
printf '%s\n' "$files" | tr '\n' '\0' | xargs -0 -n1 -P4 bun test --isolate ${options[@]+"${options[@]}"}

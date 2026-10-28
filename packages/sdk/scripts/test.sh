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
  if [[ -e "$arg" ]]; then paths+=("$arg"); else options+=("$arg"); fi
done
[[ ${#paths[@]} -gt 0 ]] || paths=(src)

find "${paths[@]}" \( -name '*.test.ts' -o -name '*.test.tsx' \) -print0 \
  | sort -z \
  | xargs -0 -r -n1 -P4 bun test --isolate ${options[@]+"${options[@]}"}

#!/usr/bin/env bash
# THE REAL BROWSER against the dev stack (pi-js.kortix.com): sign in, open a
# session, send three prompts, reload, open the Files panel, the viewer and an
# HTML preview — every check a user's own eyes would make. Playwright lives in
# the repo's `tests` workspace, so the script runs from there.
#
# Needs: KORTIX_E2E_PROJECT (a project the e2e user owns) and
# SUPABASE_ANON_KEY (the stack's anon key — inline in the page as
# window.__KORTIX_RUNTIME_CONFIG). Skips, loudly, without them.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
[ -n "${KORTIX_E2E_PROJECT:-}" ] || { echo "SKIP: no KORTIX_E2E_PROJECT (the project this drives a session in)"; exit 0; }
[ -n "${SUPABASE_ANON_KEY:-}" ] || { echo "SKIP: no SUPABASE_ANON_KEY (the dev stack's anon key)"; exit 0; }
TESTS="$HERE/../../../tests"
cp "$HERE/ui-e2e.ts" "$TESTS/.ui-e2e.scratch.ts"
cd "$TESTS" && bun .ui-e2e.scratch.ts 2>&1 | tee /tmp/ui-e2e.out | grep -a -E "^\s+(PASS|FAIL|real browser|CRASH)"
grep -a -q "real browser: [0-9]* passed, 0 failed" /tmp/ui-e2e.out

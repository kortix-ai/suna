#!/usr/bin/env bash
#
# e2e-cli-install.sh — proves, end to end, that every sandbox ships a working,
# pre-authenticated `kortix` CLI and that `git push` against the managed remote
# authenticates with zero setup.
#
# This is the regression net for the failure where an in-sandbox agent could
# not open a change request: the `kortix` binary wasn't installed, the only
# token it tried (KORTIX_TOKEN) was the sandbox service key (rejected by the
# project routes), and `git push` had no credential. See
# apps/sandbox/Dockerfile, apps/cli/src/api/{config,client}.ts, and
# apps/kortix-sandbox-agent-server/src/git.ts.
#
# What it checks:
#   1. The CLI compiles into the image and runs (`kortix --version`).
#   2. The sandbox service key (KORTIX_TOKEN, kortix_sb_…) is REJECTED on the
#      project-scoped routes — i.e. it is the wrong token, exactly as in prod.
#   3. The injected project PAT (KORTIX_CLI_TOKEN, kortix_pat_…) lets
#      `kortix cr open` / `kortix cr ls` succeed, hitting the correct
#      `/v1/projects/…` path (no double `/v1`).
#   4. The daemon's git credential helper hands `git` a fresh push-capable
#      credential for the managed remote (`git credential fill`).
#
# Requirements: docker, bun, git, curl. Run from anywhere:
#   bash apps/sandbox/scripts/e2e-cli-install.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT"

IMAGE="kortix-cli-e2e:test"
PORT="${KORTIX_E2E_PORT:-17790}"
PROJECT="proj-e2e-123"
PAT="kortix_pat_e2e_executor"          # project-scoped PAT (KORTIX_CLI_TOKEN)
SBKEY="kortix_sb_e2e_service_key"       # sandbox service key (KORTIX_TOKEN)
PUSH_TOKEN="FRESH-PUSH-TOKEN-e2e"

GREEN=$'\e[32m'; RED=$'\e[31m'; DIM=$'\e[2m'; RST=$'\e[0m'
pass() { echo "  ${GREEN}✓${RST} $1"; }
fail() { echo "  ${RED}✗ $1${RST}"; FAILED=1; }
FAILED=0

MOCK_DIR="$(mktemp -d)"
MOCK_PID=""
cleanup() {
  [ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null || true
  rm -rf "$MOCK_DIR"
}
trap cleanup EXIT

# ── Mock control plane ──────────────────────────────────────────────────────
cat > "$MOCK_DIR/mock.ts" <<MOCK
const PAT = "$PAT", SBKEY = "$SBKEY", PROJECT = "$PROJECT", PUSH = "$PUSH_TOKEN";
const crs: any[] = [];
const bearer = (r: Request) => (r.headers.get("authorization") || "").replace(/^Bearer /, "");
Bun.serve({
  port: $PORT,
  fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname, tok = bearer(req);
    // clone-credential: accepts the SANDBOX key (matches prod auth).
    if (p === \`/v1/projects/\${PROJECT}/git/clone-credential\`) {
      if (tok !== SBKEY) return Response.json({ error: "bad" }, { status: 401 });
      return Response.json({ repo_url: "https://git.freestyle.sh/repo", auth: { username: "x-access-token", token: PUSH, type: "basic" }, source: "managed" });
    }
    // change-requests: require the PROJECT PAT; reject the sandbox key.
    if (p === \`/v1/projects/\${PROJECT}/change-requests\`) {
      if (tok !== PAT) return Response.json({ error: true, message: "Invalid or expired token", status: 401 }, { status: 401 });
      if (req.method === "POST")
        return req.json().then((b: any) => { const cr = { cr_id: "cr-1", number: crs.length + 1, status: "open", title: b.title, description: b.description ?? "", head_ref: b.head_ref, base_ref: b.base_ref ?? "main", created_at: new Date(0).toISOString() }; crs.push(cr); return Response.json(cr, { status: 201 }); });
      return Response.json({ change_requests: crs });
    }
    return new Response("not found: " + p, { status: 404 });
  },
});
console.error("mock listening on $PORT");
MOCK

echo "${DIM}── building the kortix CLI into the sandbox image (cli-builder stage) ──${RST}"
DOCKER_BUILDKIT=1 docker build -f apps/sandbox/Dockerfile --target cli-builder -t "$IMAGE" . >/dev/null
echo "${DIM}── starting mock control plane on :$PORT ──${RST}"
bun "$MOCK_DIR/mock.ts" 2>"$MOCK_DIR/mock.log" &
MOCK_PID=$!
sleep 1

API_HOST="http://host.docker.internal:$PORT/v1"
drun() { docker run --rm --add-host=host.docker.internal:host-gateway "$@"; }

echo
echo "1. CLI is installed and runs"
if drun "$IMAGE" /cli/kortix --version | grep -q "Kortix CLI"; then
  pass "kortix --version works inside the image"
else
  fail "kortix --version did not run"
fi

echo
echo "2. The sandbox service key (KORTIX_TOKEN) is rejected on project routes"
OUT="$(drun -e KORTIX_CLI_TOKEN="$SBKEY" -e KORTIX_API_URL="$API_HOST" -e KORTIX_PROJECT_ID="$PROJECT" "$IMAGE" /cli/kortix cr ls 2>&1 || true)"
if echo "$OUT" | grep -qi "Token rejected"; then
  pass "service key correctly rejected (the original misdiagnosis)"
else
  fail "expected a rejection, got: $(echo "$OUT" | tail -1)"
fi

echo
echo "3. The injected project PAT (KORTIX_CLI_TOKEN) opens + lists a CR"
OUT="$(drun -e KORTIX_CLI_TOKEN="$PAT" -e KORTIX_API_URL="$API_HOST" -e KORTIX_PROJECT_ID="$PROJECT" \
  -e KORTIX_BRANCH_NAME="session-e2e" -e KORTIX_SESSION_ID="session-e2e" \
  "$IMAGE" /cli/kortix cr open --title "Add portfolio site" --description "e2e" 2>&1 || true)"
if echo "$OUT" | grep -q "Opened CR #1"; then
  pass "kortix cr open succeeded with the PAT"
else
  fail "cr open failed: $(echo "$OUT" | tail -2)"
fi
OUT="$(drun -e KORTIX_CLI_TOKEN="$PAT" -e KORTIX_API_URL="$API_HOST" -e KORTIX_PROJECT_ID="$PROJECT" "$IMAGE" /cli/kortix cr ls 2>&1 || true)"
if echo "$OUT" | grep -q "Add portfolio site"; then
  pass "kortix cr ls shows the open CR"
else
  fail "cr ls did not list the CR: $(echo "$OUT" | tail -2)"
fi
if grep -q "/v1/v1/" "$MOCK_DIR/mock.log" 2>/dev/null; then
  fail "CLI hit a doubled /v1/v1/ path"
else
  pass "API path is correct (single /v1 mount)"
fi

echo
echo "4. git push authenticates via the daemon credential helper"
DAEMON="apps/kortix-sandbox-agent-server/src/main.ts"
HOME_T="$(mktemp -d)"
HOME="$HOME_T" git config --global --replace-all "credential.https://git.freestyle.sh.helper" "!bun '$REPO_ROOT/$DAEMON' git-credential"
CRED="$(printf 'protocol=https\nhost=git.freestyle.sh\npath=repo\n\n' | \
  HOME="$HOME_T" KORTIX_API_URL="http://127.0.0.1:$PORT/v1" KORTIX_PROJECT_ID="$PROJECT" KORTIX_TOKEN="$SBKEY" \
  git credential fill 2>/dev/null || true)"
rm -rf "$HOME_T"
if echo "$CRED" | grep -q "password=$PUSH_TOKEN" && echo "$CRED" | grep -q "username=x-access-token"; then
  pass "git received a fresh push-capable credential (username=x-access-token)"
else
  fail "git credential fill did not return the push token: $CRED"
fi

echo
if [ "$FAILED" -eq 0 ]; then
  echo "${GREEN}ALL CHECKS PASSED — the sandbox CLI + token + git-push path is wired end to end.${RST}"
else
  echo "${RED}SOME CHECKS FAILED.${RST}"; exit 1
fi

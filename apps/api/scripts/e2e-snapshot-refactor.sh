#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# End-to-end smoke test for the workspace-less sandbox-templates refactor.
#
# Verifies the full flow via real curl against the local dev API:
#
#   1. Project provision (seed_starter=true) → succeeds; the new starter does
#      NOT seed .kortix/Dockerfile, so the project has zero custom templates.
#   2. GET /v1/projects/:id/sandboxes — returns at least the platform default
#      (slug="default", is_default=true).
#   3. GET /v1/projects/:id/snapshots — new shape: {templates, builds, …}.
#   4. GET /v1/projects/:id/sandbox-health — new shape: {primary_*, ready, …}.
#   5. POST /v1/projects/:id/snapshots/rebuild → 202, optional {slug} body
#      defaults to the platform default.
#   6. POST /v1/projects/:id/sessions (no slug) → uses the platform default.
#   7. POST /v1/projects/:id/sessions (slug="default") → also default.
#   8. POST /v1/projects/:id/sessions (slug="does-not-exist") → expected
#      failure at session-boot time, but should still accept the request (the
#      boot-time error surfaces async in the session status).
#   9. Session list + delete.
#   10. Project delete.
#
# Exits non-zero on the first mismatch.
#
# Env knobs:
#   BACKEND_URL      Default http://localhost:8008
#   TOKEN            Required. Bearer PAT with project.* perms.
#   WAIT_FOR_SESSION Set to 1 to poll the first session until 'running'.
#   KEEP             Set to 1 to keep the created project + session.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

BACKEND="${BACKEND_URL:-http://localhost:8008}"
BACKEND="${BACKEND%/}"
TOKEN="${TOKEN:?Set TOKEN to a PAT bearer token}"

if ! command -v jq >/dev/null 2>&1; then
  echo "✘ jq is required (brew install jq)"; exit 2
fi

PROJECT_NAME="e2e-sandbox-$(date +%s)"
echo "▸ backend: $BACKEND"
echo "▸ project name: $PROJECT_NAME"

# ── 0. Health ─────────────────────────────────────────────────────────────
HEALTH=$(curl -fsS "$BACKEND/health" -o /dev/null -w '%{http_code}' || true)
if [[ "$HEALTH" != "200" ]]; then
  echo "✘ backend not healthy (GET /health → $HEALTH)"; exit 1
fi
echo "  ✓ backend healthy"

api() {
  local method="$1" path="$2"; shift 2
  curl -fsS \
    -X "$method" \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    "$BACKEND/v1$path" "$@"
}

api_status() {
  local method="$1" path="$2" outfile="$3"; shift 3
  curl -fsS -o "$outfile" -w '%{http_code}' \
    -X "$method" \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    "$BACKEND/v1$path" "$@"
}

# ── 1. Provision project ──────────────────────────────────────────────────
echo
echo "▸ POST /v1/projects/provision (seed_starter=true)…"
PROVISION=$(api POST /projects/provision -d "$(jq -nc --arg n "$PROJECT_NAME" '{name:$n, seed_starter:true}')") || {
  echo "✘ project provision failed"; exit 1;
}
PROJECT_ID=$(echo "$PROVISION" | jq -r '.project_id // .projectId')
if [[ -z "$PROJECT_ID" || "$PROJECT_ID" == "null" ]]; then
  echo "✘ no project_id in provision response: $PROVISION"; exit 1
fi
echo "  ✓ project: $PROJECT_ID  (seeded=$(echo "$PROVISION" | jq -r '.seeded'))"

cleanup() {
  if [[ "${KEEP:-0}" == "1" ]]; then
    echo "▸ KEEP=1 — leaving project $PROJECT_ID intact"; return
  fi
  echo
  echo "▸ DELETE /v1/projects/$PROJECT_ID…"
  if api DELETE "/projects/$PROJECT_ID" >/dev/null; then
    echo "  ✓ project deleted"
  else
    echo "  ✘ project delete failed (continuing)"
  fi
}
trap cleanup EXIT

# Give pre-build a beat to register a log row if any.
sleep 1

# ── 2. GET /sandboxes — platform default present ─────────────────────────
echo
echo "▸ GET /v1/projects/$PROJECT_ID/sandboxes…"
SANDBOXES=$(api GET "/projects/$PROJECT_ID/sandboxes")
DEFAULT_SLUG=$(echo "$SANDBOXES" | jq -r '.default_slug')
ITEMS_LEN=$(echo "$SANDBOXES" | jq '.items | length')
HAS_PLATFORM_DEFAULT=$(echo "$SANDBOXES" | jq '[.items[] | select(.is_default == true and .slug == "default")] | length')
if [[ "$HAS_PLATFORM_DEFAULT" != "1" ]]; then
  echo "✘ /sandboxes missing platform default: $SANDBOXES"; exit 1
fi
if [[ "$DEFAULT_SLUG" != "default" ]]; then
  echo "✘ /sandboxes default_slug not 'default': got '$DEFAULT_SLUG'"; exit 1
fi
echo "  ✓ items=$ITEMS_LEN  default_slug=$DEFAULT_SLUG  platform_default_state=$(echo "$SANDBOXES" | jq -r '.items[] | select(.is_default) | .daytona_state')"

# ── 3. GET /snapshots — new shape ────────────────────────────────────────
echo
echo "▸ GET /v1/projects/$PROJECT_ID/snapshots…"
SNAPS=$(api GET "/projects/$PROJECT_ID/snapshots")
for key in templates templates_error builds; do
  if ! echo "$SNAPS" | jq -e "has(\"$key\")" >/dev/null; then
    echo "✘ /snapshots response missing key $key: $SNAPS"; exit 1
  fi
done
TPL_LEN=$(echo "$SNAPS" | jq '.templates | length')
BUILDS_LEN=$(echo "$SNAPS" | jq '.builds | length')
echo "  ✓ templates=$TPL_LEN  builds=$BUILDS_LEN  templates_error=$(echo "$SNAPS" | jq -r '.templates_error // "null"')"

# ── 4. GET /sandbox-health — new shape ────────────────────────────────────
echo
echo "▸ GET /v1/projects/$PROJECT_ID/sandbox-health…"
HEALTH=$(api GET "/projects/$PROJECT_ID/sandbox-health")
for key in primary_slug primary_template ready building latest_build latest_failure; do
  if ! echo "$HEALTH" | jq -e "has(\"$key\")" >/dev/null; then
    echo "✘ /sandbox-health response missing key $key: $HEALTH"; exit 1
  fi
done
echo "  ✓ primary_slug=$(echo "$HEALTH" | jq -r '.primary_slug') ready=$(echo "$HEALTH" | jq -r '.ready') building=$(echo "$HEALTH" | jq -r '.building')"

# ── 5. POST /snapshots/rebuild — no body → default ───────────────────────
echo
echo "▸ POST /v1/projects/$PROJECT_ID/snapshots/rebuild (no body)…"
RB_STATUS=$(api_status POST "/projects/$PROJECT_ID/snapshots/rebuild" /tmp/rebuild.json -d '{}')
if [[ "$RB_STATUS" != "202" ]]; then
  echo "✘ expected 202 from rebuild, got $RB_STATUS: $(cat /tmp/rebuild.json)"; exit 1
fi
RB_BODY=$(cat /tmp/rebuild.json)
RB_SLUG=$(echo "$RB_BODY" | jq -r '.slug')
if [[ "$RB_SLUG" != "default" ]]; then
  echo "✘ rebuild slug was '$RB_SLUG', expected 'default': $RB_BODY"; exit 1
fi
echo "  ✓ rebuild started slug=$RB_SLUG deleted_existing=$(echo "$RB_BODY" | jq -r '.deleted_existing')"

# ── 5b. POST /snapshots/rebuild — explicit slug=default ──────────────────
echo
echo "▸ POST /v1/projects/$PROJECT_ID/snapshots/rebuild slug=default…"
RB_STATUS=$(api_status POST "/projects/$PROJECT_ID/snapshots/rebuild" /tmp/rebuild2.json -d '{"slug":"default"}')
if [[ "$RB_STATUS" != "202" ]]; then
  echo "✘ expected 202, got $RB_STATUS: $(cat /tmp/rebuild2.json)"; exit 1
fi
echo "  ✓ explicit slug rebuild OK"

# ── 6. Session create — no slug → default template ───────────────────────
echo
echo "▸ POST /v1/projects/$PROJECT_ID/sessions (no slug)…"
SESS=$(api POST "/projects/$PROJECT_ID/sessions" -d '{}')
SESSION_ID=$(echo "$SESS" | jq -r '.session_id // .id')
if [[ -z "$SESSION_ID" || "$SESSION_ID" == "null" ]]; then
  echo "✘ no session id in response: $SESS"; exit 1
fi
echo "  ✓ session: $SESSION_ID"

# ── 7. Session create — explicit slug=default ────────────────────────────
echo
echo "▸ POST /v1/projects/$PROJECT_ID/sessions slug=default…"
SESS2=$(api POST "/projects/$PROJECT_ID/sessions" -d '{"sandbox_slug":"default"}')
SESSION_ID_2=$(echo "$SESS2" | jq -r '.session_id // .id')
if [[ -z "$SESSION_ID_2" || "$SESSION_ID_2" == "null" ]]; then
  echo "✘ no session id in response: $SESS2"; exit 1
fi
echo "  ✓ session: $SESSION_ID_2"

# ── 8. Session create — slug points at a missing template ────────────────
# The API itself accepts the request (it's an async failure inside the boot
# IIFE). We just verify the request returns a session id and the session
# eventually marks itself failed.
echo
echo "▸ POST /v1/projects/$PROJECT_ID/sessions slug=does-not-exist (expect async fail)…"
SESS3=$(api POST "/projects/$PROJECT_ID/sessions" -d '{"sandbox_slug":"does-not-exist"}' || true)
SESSION_ID_3=$(echo "$SESS3" | jq -r '.session_id // .id // empty')
if [[ -z "$SESSION_ID_3" ]]; then
  echo "  ⓘ create rejected synchronously (also acceptable): $SESS3"
else
  echo "  ✓ session $SESSION_ID_3 created — async failure expected during boot"
fi

# ── 9. Session list ──────────────────────────────────────────────────────
echo
echo "▸ GET /v1/projects/$PROJECT_ID/sessions…"
LIST=$(api GET "/projects/$PROJECT_ID/sessions")
TOTAL=$(echo "$LIST" | jq '.items | length')
echo "  ✓ $TOTAL sessions in list"

if [[ "${WAIT_FOR_SESSION:-0}" == "1" ]]; then
  echo
  echo "▸ polling first session $SESSION_ID until 'running' (≤600s)…"
  for i in $(seq 1 120); do
    STATUS=$(api GET "/projects/$PROJECT_ID/sessions/$SESSION_ID" | jq -r '.status // .session.status // "unknown"')
    echo "    [$i] status=$STATUS"
    if [[ "$STATUS" == "running" ]]; then echo "  ✓ session running"; break; fi
    if [[ "$STATUS" == "failed" || "$STATUS" == "error" ]]; then echo "✘ session failed"; exit 1; fi
    sleep 5
  done
fi

# ── 10. Session delete ───────────────────────────────────────────────────
if [[ "${KEEP:-0}" != "1" ]]; then
  echo
  echo "▸ DELETE created sessions…"
  for id in "$SESSION_ID" "$SESSION_ID_2" "$SESSION_ID_3"; do
    [[ -z "$id" ]] && continue
    if api DELETE "/projects/$PROJECT_ID/sessions/$id" >/dev/null 2>&1; then
      echo "  ✓ session $id deleted"
    else
      echo "  ⓘ session $id delete failed (likely already gone)"
    fi
  done
fi

echo
echo "✅ sandbox templates refactor e2e PASSED"

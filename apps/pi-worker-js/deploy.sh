#!/usr/bin/env bash
# DEPLOY AN AGENT ONTO PLATINUM. Two sandboxes and one bucket write.
#
#   1. the WORKSPACE — an ordinary microVM from pt-agent-daemon.spec.json. It has
#      the shell, the filesystem and the compilers. Nothing about it is special;
#      it is a normal Platinum template.
#   2. the CELL — runtime `cell`, from ../pt-celld.spec.json. celld and nothing
#      else: the agent code is NOT in this image.
#   3. the WORKER — `celld deploy` writes the bundle to the org's bucket prefix,
#      where every cell in the org picks it up at startup.
#
# That split is the point. The image is the runtime; the agent is data in the
# bucket. Shipping new agent code is a bucket write, not an image build — and
# (RUNBOOK.md §redeploy) it does NOT reach a cell that is already running, which
# is why step 3 comes with a restart, not a hope.
#
# STATUS: the CONTROL-PLANE CONTRACT is tested — test/deploy-contract.mjs runs
# this script against a stub control plane and asserts what it sends: the spec it
# builds, that the cell gets CELLD_VAR_* and NO storage credentials, that the org
# is read back rather than assumed, and that the cell is restarted afterwards.
#
# What is still unmeasured, and cannot be here: that Platinum accepts the spec,
# that the cell boots, that celld reaches the bucket through the host gateway.
# Those need an environment with the cell runtime on it, and there is not one —
# the runtime was reverted off main.
set -euo pipefail
cd "$(dirname "$0")"

: "${PT_API_URL:?PT_API_URL is required, e.g. https://api-dev.platinum.dev}"
: "${PT_TOKEN:?PT_TOKEN is required}"
# The canonical names from apps/api/src/s3.ts. That module exists because three
# call sites had each grown their own copy of this block and drifted; a fourth
# spelling here would be the same bug with a new name.
: "${PT_S3_BUCKET:?PT_S3_BUCKET is required (apps/api/src/s3.ts)}"
: "${PT_S3_ENDPOINT:?PT_S3_ENDPOINT is required}"
S3_REGION=${PT_S3_REGION:-us-east-1}
# s3.ts normalises a scheme-less endpoint — the prod value is bare
# (`s3.fr-par.scw.cloud`) — so do the same rather than requiring a spelling.
case "$PT_S3_ENDPOINT" in http*) S3_ENDPOINT="$PT_S3_ENDPOINT" ;; *) S3_ENDPOINT="https://$PT_S3_ENDPOINT" ;; esac
FLEET_PREFIX=${PT_S3_PREFIX:-}

# THE ORG NAMESPACE IS THE HOST'S DECISION, NOT A DEPLOY FLAG.
#
# cell_s3_gateway.go cellS3Prefix() calls itself "the one place an org's storage
# namespace is decided", derived from the sandbox row and never from anything the
# guest sends. `celld deploy` still has to write the bundle somewhere, and that
# somewhere must be the SAME namespace the running cell will read from — so the
# org id is read back from the sandbox the control plane just created, rather
# than passed in and hoped to match.
TOOL_TOKEN=${TOOL_TOKEN:-$(head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 32)}

api() { curl -sS -H "Authorization: Bearer ${PT_TOKEN}" -H 'content-type: application/json' "$@"; }

# CHECK EVERYTHING BEFORE CREATING ANYTHING.
#
# This script used to reach step 4 — a template built, two sandboxes created —
# and then die on `celld: command not found`, leaving both behind for someone to
# find later. A precondition discovered halfway through a deploy is an orphaned
# resource, not an error message.
#
# `celld deploy` needs the celld binary and esbuild; the celld README's install
# line is the fix, and CELLD_BIN allows a container wrapper instead.
CELLD_BIN=${CELLD_BIN:-celld}
if ! command -v "$CELLD_BIN" >/dev/null 2>&1; then
  cat >&2 <<EOM
deploy.sh: '$CELLD_BIN' is not on PATH, and step 4 needs it to write the bundle.

  Install it   : curl -fsSL https://celld.dev/install.sh | sh
  Or wrap it   : CELLD_BIN=/path/to/celld ./deploy.sh
  Or run it in a container, the way celldctl.mjs does for local testing.

Nothing has been created — this is checked before the first API call on purpose.
EOM
  exit 1
fi
command -v esbuild >/dev/null 2>&1 || echo "deploy.sh: warning — esbuild is not on PATH; 'celld deploy' needs it for a Worker project" >&2

echo "== 1. workspace template =="
npm run --silent spec
TPL=$(api -X POST "${PT_API_URL}/v1/templates/from-spec" -d @pt-agent-daemon.spec.json \
      | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
[ -n "$TPL" ] || { echo "template build did not return an id"; exit 1; }
echo "   template: $TPL"

echo "== 2. workspace sandbox =="
# The daemon runs commands, so its port is NOT public: the cell reaches it over
# the org's private network. Exposing 7070 publicly would put a shell on the
# internet behind one bearer token.
WS=$(api -X POST "${PT_API_URL}/v1/sandboxes" \
      -d "{\"templateId\":\"${TPL}\",\"envVars\":{\"TOKEN\":\"${TOOL_TOKEN}\"}}" \
      | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('id',''))")
[ -n "$WS" ] || { echo "workspace sandbox was not created"; exit 1; }
WS_IP=$(api "${PT_API_URL}/v1/sandboxes/${WS}" | python3 -c "import sys,json;print(json.load(sys.stdin).get('internalIp',''))")
echo "   workspace: $WS at ${WS_IP:-<no internal ip yet>}"

echo "== 3. the cell =="
# NO STORAGE CREDENTIALS HERE, deliberately: the host mints the sandbox its own
# S3 identity and points CELLD_ENDPOINT at the on-host gateway, which holds the
# provider key and applies the org prefix. Passing AWS_* would hand the sandbox
# the whole bucket, and the control plane refuses those keys for a cell anyway
# (cellStorage.ts CELL_CREDENTIAL_ENV_KEYS). See ../CREDENTIALS.md.
#
# THE APPLICATION SECRETS RIDE CELLD_VAR_*, NOT wrangler.json. `celld deploy`
# uploads that file's vars into the deployment manifest in the bucket — measured
# locally, three manifests held a complete OAuth token. CELLD_VAR_<NAME>
# overrides the worker var of the same name at the node, so the secret stays in
# the sandbox's environment and never reaches storage. These keys are not in
# cellStorage.ts's rejected set, which is the platform saying they are the
# tenant's to set.
CELL_ENV="{\"CELLD_VAR_TOOL_DAEMON_TOKEN\": \"${TOOL_TOKEN}\"}"
if [ -n "${MODEL_API_KEY:-}" ]; then
  CELL_ENV="{\"CELLD_VAR_TOOL_DAEMON_TOKEN\": \"${TOOL_TOKEN}\", \"CELLD_VAR_MODEL_API_KEY\": \"${MODEL_API_KEY}\"}"
fi
CELL=$(api -X POST "${PT_API_URL}/v1/sandboxes" \
        -d "{\"image\": $(cat ../pt-celld.spec.json), \"exposed_ports\": [8080], \"envVars\": ${CELL_ENV}}" \
        | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
[ -n "$CELL" ] || { echo "cell sandbox was not created"; exit 1; }
echo "   cell: $CELL"

echo "== 4. the agent bundle =="
npm run --silent build
# The daemon URL is baked into the deployment, so the workspace must exist first.
python3 - "$WS_IP" <<'PY'
import json, sys
cfg = json.load(open("wrangler.json"))
cfg.setdefault("vars", {})
# The URL is not a secret and belongs in the deployment. The TOKEN is, and does
# not: it goes to the cell as CELLD_VAR_TOOL_DAEMON_TOKEN above. Anything left
# in this file is uploaded to the bucket.
cfg["vars"]["TOOL_DAEMON_URL"] = f"http://{sys.argv[1]}:7070"
cfg["vars"].pop("TOOL_DAEMON_TOKEN", None)
cfg["vars"].pop("MODEL_API_KEY", None)
json.dump(cfg, open("wrangler.json", "w"), indent=2)
print("   wrangler.json points at the workspace (no secrets in it)")
PY
# Read the org back from the cell the control plane created, so the deploy
# prefix cannot disagree with the one the host will scope the guest to.
ORG=$(api "${PT_API_URL}/v1/sandboxes/${CELL}" | python3 -c "import sys,json;print(json.load(sys.stdin).get('orgId',''))")
[ -n "$ORG" ] || { echo "could not read the cell's org — refusing to guess a storage prefix"; exit 1; }
DEPLOY_PREFIX="${FLEET_PREFIX:+${FLEET_PREFIX}/}orgs/${ORG}"
echo "   deploying to ${PT_S3_BUCKET}/${DEPLOY_PREFIX} (org from the sandbox row)"
"$CELLD_BIN" deploy . --bucket "s3://${PT_S3_BUCKET}/${DEPLOY_PREFIX}" \
  --endpoint "${S3_ENDPOINT}" --region "${S3_REGION}"

echo "== 5. restart the cell so it loads the deployment =="
# Nodes load a deployment AT STARTUP. A cell that was already running keeps
# serving the old bundle, silently — the failure mode RUNBOOK.md documents.
api -X POST "${PT_API_URL}/v1/sandboxes/${CELL}/stop"  >/dev/null
api -X POST "${PT_API_URL}/v1/sandboxes/${CELL}/start" >/dev/null

echo
echo "cell     ${CELL}"
echo "workspace ${WS}"
echo "prompt it:"
echo "  curl -X POST \"\$PREVIEW_URL/prompt?c=session-1\" -H 'content-type: application/json' -d '{\"text\":\"hello\"}'"

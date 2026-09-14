#!/bin/bash
# Kortix legacy runtime bootstrap. Installs the supervising entrypoint and
# stages the current kortix-agent on a box whose daemon predates convergence.
# Rendered by apps/api/src/projects/lib/legacy-runtime-bootstrap.ts (placeholders below).
set -uo pipefail
STATE_DIR=/opt/kortix
ENTRYPOINT=/usr/local/bin/kortix-entrypoint
OPENCODE_HOME='__OPENCODE_HOME__'
# 'auto': the home the running OpenCode (or its data) actually uses. Image
# generations differ (2026-07-19: /opt/kortix/home; 2026-07-26: /home/kortix).
if [ "$OPENCODE_HOME" = auto ]; then
  ocp=$(pgrep -f 'opencode serve' | head -1 || true)
  OPENCODE_HOME=""
  if [ -n "$ocp" ] && [ -r "/proc/$ocp/environ" ]; then
    OPENCODE_HOME=$(tr '\0' '\n' < "/proc/$ocp/environ" | grep -m1 '^HOME=' | cut -d= -f2-)
  fi
  if [ -z "$OPENCODE_HOME" ] || [ "$OPENCODE_HOME" = / ]; then
    for cand in /home/kortix /opt/kortix/home; do
      if [ -d "$cand/.local/share/opencode" ] && [ ! -L "$cand" ]; then OPENCODE_HOME="$cand"; break; fi
    done
  fi
  [ -n "$OPENCODE_HOME" ] && [ "$OPENCODE_HOME" != / ] || OPENCODE_HOME=/opt/kortix/home
fi
RELAUNCH='__RELAUNCH__'
HEALTH_WAIT_S=__HEALTH_WAIT_S__
# Entrypoint supplied by the control plane, for an API whose manifest predates the
# `entrypoint` asset. Empty when the box's API serves it (preferred: same digest chain).
EMBEDDED_EP_B64='__ENTRYPOINT_B64__'
# pnpm the current daemon needs for its OpenCode install (`pnpm add -g --allow-build`,
# pnpm >= 10). Pinned to the fleet version when the box's Node supports it.
PNPM_PINNED='__PNPM_VERSION__'
# Session PAT minted by the control plane when this box still carries the
# pre-2026-08 `kortix_sb_` service key as KORTIX_TOKEN (the LLM gateway resolves
# only PATs). Empty when the box is already on the current token model.
NEW_KORTIX_TOKEN='__KORTIX_TOKEN__'
TOKEN_ROTATED=false
LOG=/var/log/kortix-legacy-bootstrap.log
log() { printf '[legacy-bootstrap] %s %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$LOG" >&2; }
emit() { printf '%s\n' "$1"; }
fail() {
  local msg; msg=$(printf '%s' "$2" | tr -d '"\\' | tr '\n' ' ')
  log "FAIL $1: $msg"
  emit "{\"ok\":false,\"stage\":\"$1\",\"error\":\"$msg\",\"token_rotated\":$TOKEN_ROTATED}"
  exit 1
}
# Read one variable with NO shell evaluation: process env, then /etc/environment
# (written by pt-init from the provision-time env), then the legacy daemon's own
# environment. Values are only ever assigned, never expanded.
readenv() {
  local k="$1" v=""
  v="${!k:-}"
  if [ -z "$v" ] && [ -f /etc/environment ]; then
    v=$(grep -m1 "^${k}=" /etc/environment | cut -d= -f2-)
  fi
  if [ -z "$v" ]; then
    local p; p=$(pgrep -x kortix-agent | head -1 || true)
    if [ -n "$p" ] && [ -r "/proc/$p/environ" ]; then
      v=$(tr '\0' '\n' < "/proc/$p/environ" | grep -m1 "^${k}=" | cut -d= -f2-)
    fi
  fi
  printf '%s' "$v"
}
[ "$(id -u)" = 0 ] || fail preflight "must run as root"
for b in curl sha256sum setsid pgrep; do
  command -v "$b" >/dev/null 2>&1 || fail preflight "missing $b"
done
mkdir -p "$STATE_DIR" 2>/dev/null || fail preflight "cannot create $STATE_DIR"
API=$(readenv KORTIX_API_URL); API="${API%/}"; API="${API%/v1}"
TOKEN=$(readenv KORTIX_SANDBOX_TOKEN); [ -n "$TOKEN" ] || TOKEN=$(readenv KORTIX_TOKEN)
[ -n "$API" ] || fail preflight "KORTIX_API_URL is not set on this box"
[ -n "$TOKEN" ] || fail preflight "no sandbox token on this box"
free_mb=$(df -Pm "$STATE_DIR" 2>/dev/null | awk 'NR==2{print $4}')
[ "${free_mb:-0}" -ge 400 ] || fail preflight "only ${free_mb:-0} MB free under $STATE_DIR"
MAN=$(curl -fsS --max-time 30 -H "Authorization: Bearer $TOKEN" "$API/v1/runtime-assets/manifest") \
  || fail manifest "manifest fetch from $API failed"
field() {
  if command -v python3 >/dev/null 2>&1; then
    printf '%s' "$MAN" | python3 -c 'import json,sys
m=json.load(sys.stdin); c=(m.get("components") or {}).get(sys.argv[1]) or {}
v=c.get(sys.argv[2]); print("" if v is None else v)' "$1" "$2"
  else
    printf '%s' "$MAN" | tr -d '\n ' | sed -n "s/.*\"$1\":{[^}]*\"$2\":\"\{0,1\}\([^\",}]*\)\"\{0,1\}.*/\1/p"
  fi
}
AGENT_SHA=$(field agent sha256); AGENT_PATH=$(field agent path); AGENT_VER=$(field agent version)
EP_SHA=$(field entrypoint sha256); EP_PATH=$(field entrypoint path)
BUILD=$(printf '%s' "$MAN" | tr -d '\n ' | sed -n 's/.*"build":\([0-9]*\).*/\1/p')
[ -n "$AGENT_SHA" ] && [ -n "$AGENT_PATH" ] || fail manifest "manifest has no agent component"
EP_SOURCE=manifest
if [ -z "$EP_SHA" ] || [ -z "$EP_PATH" ]; then
  [ -n "$EMBEDDED_EP_B64" ] || fail manifest "manifest has no entrypoint component and none was embedded"
  EP_SOURCE=embedded
fi
download() {
  local tmp="$3.tmp.$$"; rm -f "$tmp"
  curl -fsSL --max-time 240 --retry 2 -H "Authorization: Bearer $TOKEN" -o "$tmp" "$API$1" \
    || { rm -f "$tmp"; log "download of $1 failed"; return 1; }
  local got; got=$(sha256sum "$tmp" | cut -d' ' -f1)
  if [ "$got" != "$2" ]; then rm -f "$tmp"; log "digest mismatch for $1: want $2 got $got"; return 1; fi
  mv -f "$tmp" "$3"
}
# 1. Agent: staged for the supervisor. The baked binary is never written.
if [ -f "$STATE_DIR/agent.current" ] \
   && [ "$(sha256sum "$STATE_DIR/agent.current" | cut -d' ' -f1)" = "$AGENT_SHA" ]; then
  log "agent.current already at $AGENT_SHA"
else
  download "$AGENT_PATH" "$AGENT_SHA" "$STATE_DIR/agent.next" || fail agent "agent download failed"
  chmod 0755 "$STATE_DIR/agent.next"
  printf '%s\n' "$AGENT_SHA" > "$STATE_DIR/agent.next.sha256"
  rm -f "$STATE_DIR/agent.pinned"
fi
# 2. Entrypoint: verified, syntax-checked, installed atomically; legacy copy kept once.
if [ "$EP_SOURCE" = embedded ]; then
  printf '%s' "$EMBEDDED_EP_B64" | base64 -d > "$ENTRYPOINT.next" 2>/dev/null || fail entrypoint "embedded entrypoint failed to decode"
  EP_SHA=$(sha256sum "$ENTRYPOINT.next" | cut -d' ' -f1)
else
  download "$EP_PATH" "$EP_SHA" "$ENTRYPOINT.next" || fail entrypoint "entrypoint download failed"
fi
bash -n "$ENTRYPOINT.next" || fail entrypoint "downloaded entrypoint fails bash -n"
chmod 0755 "$ENTRYPOINT.next"
if [ -f "$ENTRYPOINT" ] && [ ! -f "$ENTRYPOINT.legacy" ]; then cp -p "$ENTRYPOINT" "$ENTRYPOINT.legacy"; fi
mv -f "$ENTRYPOINT.next" "$ENTRYPOINT"
# 3. pnpm floor. The current daemon installs OpenCode with `pnpm add -g
#    --allow-build`, a pnpm >= 10 flag; a 2026-07 image ships pnpm 8. pnpm 11
#    needs Node >= 22.13, so pick by the Node this box actually has. pnpm 10
#    also refuses a global install without a global bin dir: the image sets
#    PNPM_HOME at build time, so give this box the same layout through pnpm's
#    own rc file under the daemon home — persistent, and independent of which
#    environment a later boot hands the daemon.
PNPM_HOME_DIR=/home/kortix/.local/share/pnpm
pnpm_major=$( (pnpm --version 2>/dev/null || echo 0) | cut -d. -f1 )
node_minor=$(node --version 2>/dev/null | sed -E 's/^v[0-9]+\.([0-9]+).*/\1/')
node_major=$(node --version 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/')
if [ "${pnpm_major:-0}" -lt 10 ] 2>/dev/null; then
  want="$PNPM_PINNED"
  if [ "${node_major:-0}" -lt 22 ] || { [ "${node_major:-0}" -eq 22 ] && [ "${node_minor:-0}" -lt 13 ]; }; then want="10"; fi
  [ -n "$want" ] || want="10"
  log "pnpm $(pnpm --version 2>/dev/null || echo none) is below 10; installing pnpm@$want (node $(node --version 2>/dev/null))"
  HOME="$OPENCODE_HOME" npm install -g "pnpm@$want" >>"$LOG" 2>&1 || fail pnpm "npm install -g pnpm@$want failed"
  pnpm_now=$(pnpm --version 2>/dev/null || true)
  [ "$(printf '%s' "$pnpm_now" | cut -d. -f1)" -ge 10 ] 2>/dev/null || fail pnpm "pnpm still unusable after install: '$pnpm_now'"
  log "pnpm now $pnpm_now"
fi
# 4. HOME shim: the current daemon derives OpenCode's home from $HOME. Keep the
#    existing transcript database reachable from either path.
if [ -d "$OPENCODE_HOME" ] && [ ! -e /home/kortix ]; then
  mkdir -p /home && ln -s "$OPENCODE_HOME" /home/kortix
fi
mkdir -p "$PNPM_HOME_DIR" "$OPENCODE_HOME/.config/pnpm"
PNPM_RC="$OPENCODE_HOME/.config/pnpm/rc"
# The entrypoint puts ${PNPM_HOME_DIR}/bin on PATH on every boot, and pnpm
# refuses a global bin dir that is not on PATH — so that exact path is the
# bin dir. Rewrite, never append: a stale value from an earlier attempt must lose.
touch "$PNPM_RC"
sed -i '/^global-bin-dir=/d;/^global-dir=/d' "$PNPM_RC"
printf 'global-bin-dir=%s/bin\nglobal-dir=%s/global\n' "$PNPM_HOME_DIR" "$PNPM_HOME_DIR" >> "$PNPM_RC"
mkdir -p "$PNPM_HOME_DIR/bin" "$PNPM_HOME_DIR/global"
# PNPM_HOME is what pnpm >= 10 reads first; persist it where pt-init re-exports
# on a cold boot, and hand it to the relaunched chain. The value is the bin
# path the entrypoint puts on PATH, so pnpm's PATH check passes on every boot.
for f in /etc/environment /etc/pt-env; do
  [ -f "$f" ] || continue
  if grep -q '^PNPM_HOME=' "$f"; then sed -i "s#^PNPM_HOME=.*#PNPM_HOME=${PNPM_HOME_DIR}/bin#" "$f"
  else printf 'PNPM_HOME=%s/bin\n' "$PNPM_HOME_DIR" >> "$f"; fi
done
export PNPM_HOME="$PNPM_HOME_DIR/bin"
pnpm_final=$(pnpm --version 2>/dev/null || true)
[ "$(printf '%s' "$pnpm_final" | cut -d. -f1)" -ge 10 ] 2>/dev/null || fail pnpm "pnpm unusable: '$pnpm_final'"
log "pnpm $pnpm_final, PNPM_HOME=$PNPM_HOME, rc at $PNPM_RC"
# Ownership. Image generations from 2026-07-26 run the daemon as `kortix`, and
# the supervisor promotes agent.next by rename inside $STATE_DIR — so the
# state dir and the pnpm config must belong to that user, as the image itself
# arranges (`chown -R kortix:kortix /opt/kortix` at build). A box without the
# user keeps running everything as root.
if id kortix >/dev/null 2>&1; then
  chown -R kortix:kortix "$STATE_DIR" "$PNPM_HOME_DIR" "$OPENCODE_HOME/.config/pnpm" 2>/dev/null || true
  # The daemon replaces the CLI in place at /usr/local/bin/kortix; as `kortix`
  # it needs to own that file (the image only chowns /opt/kortix).
  [ -f /usr/local/bin/kortix ] && chown kortix:kortix /usr/local/bin/kortix 2>/dev/null || true
fi
# 5. Token model. Current boxes carry one session PAT as KORTIX_TOKEN. Rewrite
#    the persisted value (pt-init re-exports /etc/environment on a cold boot)
#    and hand it to the relaunched chain; the daemon's inbound auth compares
#    against the same variable, and the control plane stores it as the
#    sandbox service key in the same transaction.
if [ -n "$NEW_KORTIX_TOKEN" ]; then
  for f in /etc/environment /etc/pt-env; do
    [ -f "$f" ] || continue
    if grep -q '^KORTIX_TOKEN=' "$f"; then
      sed -i "s#^KORTIX_TOKEN=.*#KORTIX_TOKEN=${NEW_KORTIX_TOKEN}#" "$f"
    else
      printf 'KORTIX_TOKEN=%s\n' "$NEW_KORTIX_TOKEN" >> "$f"
    fi
  done
  export KORTIX_TOKEN="$NEW_KORTIX_TOKEN"
  TOKEN_ROTATED=true
  log "KORTIX_TOKEN rotated to a session PAT"
fi
PREV_OC=$(/usr/local/bin/opencode --version 2>/dev/null | head -1 | tr -d '"\\' || true)
printf '{"at":"%s","agent_sha256":"%s","agent_version":"%s","entrypoint_sha256":"%s","manifest_build":"%s","previous_opencode":"%s"}\n' \
  "$(date -u +%FT%TZ)" "$AGENT_SHA" "$AGENT_VER" "$EP_SHA" "$BUILD" "$PREV_OC" > "$STATE_DIR/legacy-bootstrap.json"
log "staged agent $AGENT_VER ($AGENT_SHA) and entrypoint $EP_SHA from $EP_SOURCE (previous opencode: $PREV_OC)"
if [ "$RELAUNCH" != "pt-app" ]; then
  emit "{\"ok\":true,\"stage\":\"staged\",\"agent_sha256\":\"$AGENT_SHA\",\"entrypoint_sha256\":\"$EP_SHA\",\"previous_opencode\":\"$PREV_OC\",\"token_rotated\":$TOKEN_ROTATED}"
  exit 0
fi
# 6. Relaunch in place. pt-init started /sbin/pt-app once and never respawns it.
#    The chain is  sh -c kortix-entrypoint  →  bash kortix-entrypoint (the
#    supervisor loop on a converged box)  →  the daemon (baked kortix-agent, or
#    /opt/kortix/agent.current once supervised)  →  opencode. Stop the SUPERVISOR
#    first so it cannot relaunch or count an early exit against the staged
#    binary, then the daemon(s) by path, then opencode; only then start one
#    fresh chain.
[ -x /sbin/pt-app ] || fail relaunch "/sbin/pt-app is missing"
stop_runtime_chain() {
  local sup agents oc
  sup=$(pgrep -f 'kortix-entrypoint' || true)
  agents=$(pgrep -f '/usr/local/bin/kortix-agent|/opt/kortix/agent\.(current|prev|next)' || true)
  oc=$(pgrep -f 'opencode serve' || true)
  for p in $sup; do kill -TERM "$p" 2>/dev/null || true; done
  for p in $agents; do kill -TERM "$p" 2>/dev/null || true; done
  for i in $(seq 1 20); do
    pgrep -f '/usr/local/bin/kortix-agent|/opt/kortix/agent\.(current|prev|next)' >/dev/null 2>&1 || break
    sleep 0.5
  done
  for p in $sup $agents $oc; do kill -KILL "$p" 2>/dev/null || true; done
  pkill -KILL -f 'opencode serve' 2>/dev/null || true
  sleep 1
}
stop_runtime_chain
# A previous attempt may have rolled the supervisor back and latched updates off.
rm -f "$STATE_DIR/agent.pinned"
HOME="$OPENCODE_HOME" PNPM_HOME="$PNPM_HOME" setsid nohup /sbin/pt-app </dev/null >>/var/log/pt-app.log 2>&1 &
disown 2>/dev/null || true
ok=0
for i in $(seq 1 "$HEALTH_WAIT_S"); do
  h=$(curl -fsS --max-time 3 http://127.0.0.1:8000/kortix/health 2>/dev/null || true)
  up=$(printf '%s' "$h" | tr -d '\n ' | sed -n 's/.*"uptime_s":\([0-9]*\).*/\1/p')
  case "$h" in *'"runtime"'*) [ "${up:-999999}" -le "$((HEALTH_WAIT_S + 30))" ] && { ok=1; break; } ;; esac
  sleep 1
done
if [ "$ok" != 1 ]; then
  log "relaunched daemon did not answer within ${HEALTH_WAIT_S}s; restoring the legacy chain"
  [ -f "$ENTRYPOINT.legacy" ] && cp -p "$ENTRYPOINT.legacy" "$ENTRYPOINT"
  rm -f "$STATE_DIR/agent.next" "$STATE_DIR/agent.next.sha256" "$STATE_DIR/agent.current"
  stop_runtime_chain
  HOME=/ setsid nohup /sbin/pt-app </dev/null >>/var/log/pt-app.log 2>&1 &
  disown 2>/dev/null || true
  fail relaunch "new daemon health timeout after ${HEALTH_WAIT_S}s"
fi
log "relaunched: daemon reports a runtime block"
emit "{\"ok\":true,\"stage\":\"relaunched\",\"agent_sha256\":\"$AGENT_SHA\",\"entrypoint_sha256\":\"$EP_SHA\",\"previous_opencode\":\"$PREV_OC\",\"token_rotated\":$TOKEN_ROTATED}"

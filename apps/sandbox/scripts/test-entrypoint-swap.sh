#!/usr/bin/env bash
# Supervisor tests for apps/sandbox/entrypoint.sh.
#
# The supervisor decides whether a box comes back up. Every path below is a way
# it could brick one, so each is exercised against the REAL script with a stub
# daemon rather than a re-implementation of the logic.
#
# The workspace-stabilization half is skipped by pointing KORTIX_WORKSPACE at a
# writable temp dir; only the supervisor loop is under test.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENTRYPOINT="${SCRIPT_DIR}/../entrypoint.sh"
pass=0
fail=0

ok() { echo "PASS  $1"; pass=$((pass + 1)); }
no() { echo "FAIL  $1 — $2"; fail=$((fail + 1)); }

sha_of() { sha256sum "$1" | cut -d' ' -f1; }

# A stub "daemon": prints a marker, then exits with whatever its own marker file
# says. Lets one test drive several generations of binary.
make_agent() { # <path> <marker> <exit-code> [sleep]
  cat > "$1" <<EOF
#!/usr/bin/env bash
echo "AGENT:$2" >> "\${KORTIX_TEST_LOG}"
sleep "${4:-0}"
exit $3
EOF
  chmod +x "$1"
}

run_case() { # <name>  (expects $TMP prepared by caller)
  KORTIX_TEST_LOG="${TMP}/log" \
  KORTIX_COMPILED_BOOT_MODE="${KORTIX_TEST_COMPILED_MODE:-off}" \
  KORTIX_AGENT_BIN="${TMP}/bin/kortix-agent" \
  KORTIX_AGENT_STATE_DIR="${TMP}/state" \
  KORTIX_WORKSPACE="${TMP}/ws" \
    bash "${ENTRYPOINT}" >"${TMP}/out" 2>&1
  echo $?
}

setup() {
  TMP="$(mktemp -d)"
  mkdir -p "${TMP}/bin" "${TMP}/state" "${TMP}/ws"
  : > "${TMP}/log"
}

# ---------------------------------------------------------------------------
# 1. No staged binary: the supervisor is a pass-through and preserves exit code.
# ---------------------------------------------------------------------------
setup
make_agent "${TMP}/bin/kortix-agent" v1 0
code=$(run_case)
[ "${code}" = "0" ] && [ "$(grep -c AGENT:v1 "${TMP}/log")" = "1" ] \
  && ok "clean run: daemon runs once, exit code preserved" \
  || no "clean run" "code=${code} runs=$(grep -c AGENT:v1 "${TMP}/log")"
rm -rf "${TMP}"

# ---------------------------------------------------------------------------
# 2. A non-zero exit is still honoured (the provider decides what stopped means).
# ---------------------------------------------------------------------------
setup
make_agent "${TMP}/bin/kortix-agent" v1 3
code=$(run_case)
[ "${code}" = "3" ] && ok "non-zero exit propagates" || no "non-zero exit" "code=${code}"
rm -rf "${TMP}"

# ---------------------------------------------------------------------------
# 3. THE HAPPY PATH. v1 stages a good v2 and asks for the swap; the supervisor
#    installs it, relaunches, and v2 runs.
# ---------------------------------------------------------------------------
setup
# Faithful to production: the daemon stages the new binary DURING its own run
# (that is what reconcileRuntimeAssets does), then asks for the swap.
cat > "${TMP}/bin/kortix-agent" <<'EOF'
#!/usr/bin/env bash
echo "AGENT:v1" >> "${KORTIX_TEST_LOG}"
cat > "${KORTIX_AGENT_STATE_DIR}/agent.next" <<'INNER'
#!/usr/bin/env bash
echo "AGENT:v2" >> "${KORTIX_TEST_LOG}"
exit 0
INNER
chmod +x "${KORTIX_AGENT_STATE_DIR}/agent.next"
sha256sum "${KORTIX_AGENT_STATE_DIR}/agent.next" | cut -d' ' -f1 > "${KORTIX_AGENT_STATE_DIR}/agent.next.sha256"
exit 75
EOF
chmod +x "${TMP}/bin/kortix-agent"
code=$(run_case)
if [ "${code}" = "0" ] && grep -q AGENT:v1 "${TMP}/log" && grep -q AGENT:v2 "${TMP}/log" \
   && [ ! -f "${TMP}/state/agent.next" ] && [ -x "${TMP}/state/agent.current" ]; then
  ok "swap: staged binary promoted, relaunched, installed as current"
else
  no "swap" "code=${code} log=$(tr '\n' ',' < "${TMP}/log") next=$([ -f "${TMP}/state/agent.next" ] && echo present || echo gone)"
fi
rm -rf "${TMP}"

# ---------------------------------------------------------------------------
# 4. Corrupt artifact: digest mismatch must NOT be installed. The running binary
#    survives. This is the difference between a bad download and a dead fleet.
# ---------------------------------------------------------------------------
setup
make_agent "${TMP}/state/agent.next" v2 0
echo "0000000000000000000000000000000000000000000000000000000000000000" > "${TMP}/state/agent.next.sha256"
cat > "${TMP}/bin/kortix-agent" <<'EOF'
#!/usr/bin/env bash
echo "AGENT:v1" >> "${KORTIX_TEST_LOG}"
if [ -f "${KORTIX_AGENT_STATE_DIR}/ran-once" ]; then exit 0; fi
: > "${KORTIX_AGENT_STATE_DIR}/ran-once"
exit 75
EOF
chmod +x "${TMP}/bin/kortix-agent"
code=$(run_case)
if ! grep -q AGENT:v2 "${TMP}/log" && [ ! -f "${TMP}/state/agent.next" ] && [ "${code}" = "0" ]; then
  ok "bad digest: staged binary discarded, live binary kept running"
else
  no "bad digest" "code=${code} log=$(tr '\n' ',' < "${TMP}/log")"
fi
rm -rf "${TMP}"

# ---------------------------------------------------------------------------
# 5. No digest at all: refuse. An unverifiable binary is never installed.
# ---------------------------------------------------------------------------
setup
make_agent "${TMP}/state/agent.next" v2 0
cat > "${TMP}/bin/kortix-agent" <<'EOF'
#!/usr/bin/env bash
echo "AGENT:v1" >> "${KORTIX_TEST_LOG}"
if [ -f "${KORTIX_AGENT_STATE_DIR}/ran-once" ]; then exit 0; fi
: > "${KORTIX_AGENT_STATE_DIR}/ran-once"
exit 75
EOF
chmod +x "${TMP}/bin/kortix-agent"
code=$(run_case)
! grep -q AGENT:v2 "${TMP}/log" && [ ! -f "${TMP}/state/agent.next" ] \
  && ok "unverifiable staged binary refused" \
  || no "unverifiable staged binary" "log=$(tr '\n' ',' < "${TMP}/log")"
rm -rf "${TMP}"

# ---------------------------------------------------------------------------
# 6. THE ONE THAT MATTERS. A new binary that dies immediately must roll back to
#    the previous one and latch, instead of crash-looping the box forever.
# ---------------------------------------------------------------------------
setup
# v2 is broken: always exits 1 straight away.
cat > "${TMP}/state/agent.next" <<'EOF'
#!/usr/bin/env bash
echo "AGENT:v2-broken" >> "${KORTIX_TEST_LOG}"
exit 1
EOF
chmod +x "${TMP}/state/agent.next"
sha_of "${TMP}/state/agent.next" > "${TMP}/state/agent.next.sha256"
# v1 asks for the swap once, then (as the restored binary) runs fine.
cat > "${TMP}/bin/kortix-agent" <<'EOF'
#!/usr/bin/env bash
echo "AGENT:v1" >> "${KORTIX_TEST_LOG}"
if [ -f "${KORTIX_AGENT_STATE_DIR}/asked" ]; then exit 0; fi
: > "${KORTIX_AGENT_STATE_DIR}/asked"
exit 75
EOF
chmod +x "${TMP}/bin/kortix-agent"
code=$(run_case)
broken_runs=$(grep -c AGENT:v2-broken "${TMP}/log")
if [ -f "${TMP}/state/agent.pinned" ] && [ "${broken_runs}" -le 2 ] \
   && [ "$(tail -1 "${TMP}/log")" = "AGENT:v1" ] && [ "${code}" = "0" ]; then
  ok "crash-looping update rolls back to the baked binary and pins"
else
  no "rollback" "code=${code} brokenRuns=${broken_runs} pinned=$([ -f "${TMP}/state/agent.pinned" ] && echo yes || echo no) log=$(tr '\n' ',' < "${TMP}/log")"
fi
rm -rf "${TMP}"

# ---------------------------------------------------------------------------
# 6b. The baked binary is an IMMUTABLE FLOOR. An update never writes it, so a
#     box can always fall back to what shipped in the image. This is the
#     property that makes bricking impossible rather than unlikely.
# ---------------------------------------------------------------------------
setup
make_agent "${TMP}/bin/kortix-agent" baked 0
baked_before=$(sha_of "${TMP}/bin/kortix-agent")
cat > "${TMP}/state/agent.next" <<'EOF'
#!/usr/bin/env bash
echo "AGENT:update" >> "${KORTIX_TEST_LOG}"
exit 0
EOF
chmod +x "${TMP}/state/agent.next"
sha_of "${TMP}/state/agent.next" > "${TMP}/state/agent.next.sha256"
code=$(run_case)
baked_after=$(sha_of "${TMP}/bin/kortix-agent")
if [ "${baked_before}" = "${baked_after}" ] && grep -q AGENT:update "${TMP}/log" \
   && [ -x "${TMP}/state/agent.current" ]; then
  ok "update installs beside the baked binary and never overwrites it"
else
  no "immutable floor" "bakedChanged=$([ "${baked_before}" = "${baked_after}" ] && echo no || echo YES) log=$(tr '\n' ',' < "${TMP}/log")"
fi
rm -rf "${TMP}"

# ---------------------------------------------------------------------------
# 6c. Regression guard. The FIRST update has no predecessor to roll back to, so
#     an implementation keying rollback off `agent.prev` leaves exactly the
#     first bad rollout unrecoverable — the rollout most likely to be bad.
#     Removing the override must drop the box back to the baked binary.
# ---------------------------------------------------------------------------
setup
make_agent "${TMP}/bin/kortix-agent" baked-good 0
cat > "${TMP}/state/agent.next" <<'EOF'
#!/usr/bin/env bash
echo "AGENT:first-update-broken" >> "${KORTIX_TEST_LOG}"
exit 1
EOF
chmod +x "${TMP}/state/agent.next"
sha_of "${TMP}/state/agent.next" > "${TMP}/state/agent.next.sha256"
code=$(run_case)
if [ -f "${TMP}/state/agent.pinned" ] && [ ! -f "${TMP}/state/agent.current" ] \
   && [ "$(tail -1 "${TMP}/log")" = "AGENT:baked-good" ]; then
  ok "first bad update with no predecessor falls back to the baked binary"
else
  no "first-update rollback" "pinned=$([ -f "${TMP}/state/agent.pinned" ] && echo yes || echo no) current=$([ -f "${TMP}/state/agent.current" ] && echo present || echo gone) log=$(tr '\n' ',' < "${TMP}/log")"
fi
rm -rf "${TMP}"

# ---------------------------------------------------------------------------
# 7. Once pinned, a staged binary is discarded — no re-download loop of a build
#    already known to be bad.
# ---------------------------------------------------------------------------
setup
: > "${TMP}/state/agent.pinned"
make_agent "${TMP}/state/agent.next" v2 0
sha_of "${TMP}/state/agent.next" > "${TMP}/state/agent.next.sha256"
make_agent "${TMP}/bin/kortix-agent" v1 0
code=$(run_case)
! grep -q AGENT:v2 "${TMP}/log" && [ ! -f "${TMP}/state/agent.next" ] \
  && ok "pinned box refuses staged updates" \
  || no "pinned" "log=$(tr '\n' ',' < "${TMP}/log")"
rm -rf "${TMP}"

setup
cat > "${TMP}/bin/kortix-agent" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "install-compiled-runtime" ]; then
  cat > "${KORTIX_AGENT_STATE_DIR}/server.mjs" <<'MJS'
import { spawnSync } from "node:child_process";
const child = spawnSync(process.env.KORTIX_AGENT_BIN, ["compiled-child"], { env: process.env, stdio: "inherit" });
process.exit(child.status ?? 1);
MJS
  echo "${KORTIX_AGENT_STATE_DIR}/server.mjs"
  exit 0
fi
echo "AGENT:${1:-legacy}" >> "${KORTIX_TEST_LOG}"
exit 0
EOF
chmod +x "${TMP}/bin/kortix-agent"
KORTIX_TEST_COMPILED_MODE=prefer
code=$(run_case)
unset KORTIX_TEST_COMPILED_MODE
[ "${code}" = "0" ] && grep -q 'AGENT:compiled-child' "${TMP}/log" \
  && ok "compiled prefer: verified server.mjs launches the agent" \
  || no "compiled prefer" "code=${code} log=$(tr '\n' ',' < "${TMP}/log")"
rm -rf "${TMP}"

setup
cat > "${TMP}/bin/kortix-agent" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "install-compiled-runtime" ]; then exit 1; fi
echo "AGENT:legacy" >> "${KORTIX_TEST_LOG}"
exit 0
EOF
chmod +x "${TMP}/bin/kortix-agent"
KORTIX_TEST_COMPILED_MODE=prefer
code=$(run_case)
unset KORTIX_TEST_COMPILED_MODE
[ "${code}" = "0" ] && grep -q 'AGENT:legacy' "${TMP}/log" \
  && ok "compiled prefer: failed install falls back to the baked agent" \
  || no "compiled prefer fallback" "code=${code} log=$(tr '\n' ',' < "${TMP}/log")"
rm -rf "${TMP}"

setup
cat > "${TMP}/bin/kortix-agent" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "install-compiled-runtime" ]; then exit 1; fi
echo "AGENT:must-not-run" >> "${KORTIX_TEST_LOG}"
exit 0
EOF
chmod +x "${TMP}/bin/kortix-agent"
KORTIX_TEST_COMPILED_MODE=required
code=$(run_case)
unset KORTIX_TEST_COMPILED_MODE
[ "${code}" = "1" ] && ! grep -q 'AGENT:must-not-run' "${TMP}/log" \
  && ok "compiled required: failed install stops before legacy boot" \
  || no "compiled required" "code=${code} log=$(tr '\n' ',' < "${TMP}/log")"
rm -rf "${TMP}"

echo
echo "${pass} passed, ${fail} failed"
[ "${fail}" -eq 0 ]

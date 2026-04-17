#!/bin/bash
#
# start-sandbox.sh — Kortix sandbox Docker workload setup
#
# Runs once during image build. The snapshot preserves everything for future boots.
# On boot from snapshot, the systemd service waits for fresh env vars before starting.
#
# Usage: start-sandbox.sh <docker-image>
#
set -euo pipefail

DOCKER_IMAGE="${1:?Usage: start-sandbox.sh <docker-image>}"

# ── Provider config (change these when switching providers) ───────────────
PROVIDER_CONFIG="/etc/justavps/config.json"
ENV_FILE="/etc/justavps/env"
PORTS_FILE="/etc/justavps/docker-host-ports"
CONTAINER="justavps-workload"
VOLUME="justavps-data"
SERVICE="justavps-docker"
STARTUP_PATCH="/usr/local/bin/kortix-startup-patch.sh"

# ── Sandbox port map ─────────────────────────────────────────────────────
PORTS=(
  3000:3000 8000:8000 8080:8080
  6080:6080 6081:6081 3111:3111 3210:3210
  3211:3211 9223:9223 9224:9224 22222:22
)

# ── Helpers ───────────────────────────────────────────────────────────────
stage_callback() {
  [ -f "$PROVIDER_CONFIG" ] || return 0
  local stage="$1" msg="$2"
  local slug cb token
  slug=$(python3 -c "import json; print(json.load(open('$PROVIDER_CONFIG'))['slug'])" 2>/dev/null) || return 0
  cb=$(python3 -c "import json; print(json.load(open('$PROVIDER_CONFIG'))['callback_url'])" 2>/dev/null) || return 0
  token=$(python3 -c "import json; print(json.load(open('$PROVIDER_CONFIG'))['machine_token'])" 2>/dev/null) || return 0
  curl -sf -X POST "${cb}/api/v1/internal/stage" \
    -H "Content-Type: application/json" \
    -d "{\"slug\":\"${slug}\",\"machine_token\":\"${token}\",\"stage\":\"${stage}\",\"message\":\"${msg}\"}" \
    >/dev/null 2>&1 || true
}

wait_for() {
  local desc="$1"; shift
  echo "[kortix] Waiting for ${desc}..."
  for i in $(seq 1 120); do
    "$@" && return 0
    sleep 2
  done
  echo "[kortix] Timed out waiting for ${desc}"
}

# ── Build port args ───────────────────────────────────────────────────────
PORT_ARGS=""
HOST_PORTS=()
for mapping in "${PORTS[@]}"; do
  PORT_ARGS="${PORT_ARGS} -p ${mapping}"
  HOST_PORTS+=("${mapping%%:*}")
done

# ── Write docker start script (baked into snapshot) ───────────────────────
curl -fsSL https://raw.githubusercontent.com/kortix-ai/suna/main/core/startup.sh -o "${STARTUP_PATCH}"
chmod +x "${STARTUP_PATCH}"

cat > /usr/local/bin/${SERVICE}-start.sh << STARTEOF
#!/bin/bash
set -euo pipefail
BOOT_TIME=\$(stat -c %Y /proc/1 2>/dev/null || echo 0)
for i in \$(seq 1 120); do
  if [ -s "${ENV_FILE}" ]; then
    ENV_MTIME=\$(stat -c %Y "${ENV_FILE}" 2>/dev/null || echo 0)
    if [ "\$ENV_MTIME" -gt "\$BOOT_TIME" ]; then
      break
    fi
    if grep -Eq '^(INTERNAL_SERVICE_KEY|KORTIX_TOKEN|KORTIX_API_URL)=' "${ENV_FILE}" 2>/dev/null; then
      echo "[kortix] Reusing persisted env file ${ENV_FILE}"
      break
    fi
  fi
  sleep 1
done
[ -s "${ENV_FILE}" ] || touch "${ENV_FILE}"
docker rm -f ${CONTAINER} 2>/dev/null || true
exec docker run --rm --name ${CONTAINER} --env-file "${ENV_FILE}" -e KORTIX_ENABLE_INNER_DOCKER=0 \\
  --privileged --cap-add SYS_ADMIN --security-opt seccomp=unconfined --shm-size 2g \\
  -v ${STARTUP_PATCH}:/ephemeral/startup.sh:ro -v ${VOLUME}:/workspace -v ${VOLUME}:/config ${PORT_ARGS} \\
  ${DOCKER_IMAGE}
STARTEOF
chmod +x /usr/local/bin/${SERVICE}-start.sh

# ── Systemd service ───────────────────────────────────────────────────────
cat > /etc/systemd/system/${SERVICE}.service << SVCEOF
[Unit]
Description=Kortix sandbox workload
After=network-online.target docker.service
Requires=docker.service
Wants=network-online.target
[Service]
Type=simple
ExecStartPre=/bin/sh -lc 'systemctl reset-failed docker.service ${SERVICE}.service >/dev/null 2>&1 || true'
ExecStartPre=/bin/systemctl start docker.service
ExecStartPre=/bin/sh -lc '/usr/bin/docker rm -f ${CONTAINER} >/dev/null 2>&1 || true'
ExecStart=/usr/local/bin/${SERVICE}-start.sh
Restart=always
RestartSec=3
StartLimitIntervalSec=0
TimeoutStartSec=0
[Install]
WantedBy=multi-user.target
SVCEOF

# ── Metadata files ────────────────────────────────────────────────────────
mkdir -p "$(dirname "$PORTS_FILE")"
printf '%s\n' "${HOST_PORTS[@]}" > "$PORTS_FILE"

docker volume create ${VOLUME} 2>/dev/null || true
WS=$(docker volume inspect ${VOLUME} --format '{{.Mountpoint}}')
mkdir -p "${WS}/.kortix"
cat > "${WS}/.kortix/container.json" << CFGEOF
{
  "image": "${DOCKER_IMAGE}",
  "name": "${CONTAINER}",
  "volumes": ["${STARTUP_PATCH}:/ephemeral/startup.sh:ro", "${VOLUME}:/workspace", "${VOLUME}:/config"],
  "ports": ["3000:3000", "8000:8000", "8080:8080", "6080:6080", "6081:6081", "3111:3111", "3210:3210", "3211:3211", "9223:9223", "9224:9224", "22222:22"],
  "caps": ["SYS_ADMIN"],
  "shmSize": "2g",
  "envFile": "${ENV_FILE}",
  "securityOpt": ["seccomp=unconfined"]
}
CFGEOF

# ── Pull image ────────────────────────────────────────────────────────────
stage_callback "docker_pulling" "Pulling Docker image..."
echo "[kortix] Pulling $DOCKER_IMAGE..."
docker pull "$DOCKER_IMAGE"

# ── Host SSH bridge into the sandbox container ───────────────────────────
# Makes `ssh abc@<ip>` land inside the Docker sandbox while preserving
# host admin access for root. Auth keys are read from the container.

id -u abc >/dev/null 2>&1 || useradd -m -s /bin/bash abc
passwd -l abc >/dev/null 2>&1 || true
usermod -aG docker abc >/dev/null 2>&1 || true

cat > /usr/local/bin/kortix-authorized-keys << 'AUTHORIZEDKEYSEOF'
#!/bin/bash
set -euo pipefail
USER_NAME="${1:-}"
[ "$USER_NAME" = "abc" ] || exit 0
docker exec justavps-workload sh -lc 'cat /config/.ssh/authorized_keys 2>/dev/null' || true
AUTHORIZEDKEYSEOF
chmod +x /usr/local/bin/kortix-authorized-keys

cat > /usr/local/bin/kortix-container-shell << 'CONTAINERSHELLEOF'
#!/bin/bash
set -euo pipefail
TTY_ARGS=(-i)
if [ -t 0 ] && [ -t 1 ]; then
  TTY_ARGS+=(-t)
fi
if [ -n "${SSH_ORIGINAL_COMMAND:-}" ]; then
  exec docker exec -i \
    -u abc -w /workspace -e HOME=/config -e USER=abc -e LOGNAME=abc \
    -e TERM="${TERM:-xterm-256color}" \
    justavps-workload sh -lc "$SSH_ORIGINAL_COMMAND"
fi
exec docker exec "${TTY_ARGS[@]}" \
  -u abc -w /workspace -e HOME=/config -e USER=abc -e LOGNAME=abc \
  -e TERM="${TERM:-xterm-256color}" \
  justavps-workload bash -l
CONTAINERSHELLEOF
chmod +x /usr/local/bin/kortix-container-shell

mkdir -p /etc/ssh/sshd_config.d
cat > /etc/ssh/sshd_config.d/kortix-sandbox.conf << 'SSHEOF'
Match User abc
    PasswordAuthentication no
    PubkeyAuthentication yes
    AuthorizedKeysCommand /usr/local/bin/kortix-authorized-keys %u
    AuthorizedKeysCommandUser root
    PermitTTY yes
    X11Forwarding no
    PermitTunnel no
    GatewayPorts no
    ForceCommand /usr/local/bin/kortix-container-shell
SSHEOF

systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true

# ── Enable and start ──────────────────────────────────────────────────────
systemctl daemon-reload
systemctl enable ${SERVICE} 2>/dev/null || true
systemctl start ${SERVICE}

wait_for "container" sh -c "docker ps --format '{{.Names}}' 2>/dev/null | grep -q ${CONTAINER}"
stage_callback "docker_running" "Docker container started"

stage_callback "services_starting" "Services booting..."
wait_for "services" sh -c "curl -sf http://localhost:8000/kortix/health >/dev/null 2>&1"
stage_callback "services_ready" "All services are up"

echo "[kortix] Sandbox ready."

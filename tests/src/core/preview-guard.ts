/**
 * The self-healing guard a persistent branch environment runs on its own box.
 *
 * A branch environment (`previewSandboxIdentity` with `branchEnv`) is one
 * sandbox reused across every push, fronted by a stable public name. Between
 * deploys nothing on that box watches it, and three failure modes each took
 * the pi-worker branch environment dark for hours, all observed on 2026-09-04:
 *
 *   1. DISK. Every deploy pulls ~2.5 GB of new images and nothing pruned the
 *      superseded ones; at 100% supabase-db crash-loops on `postmaster.pid`
 *      and the whole stack goes down (34 GB of images, 25 GB unreferenced).
 *   2. A FAILED DEPLOY leaves every container in `Created` and nothing
 *      serving: the bootstrap's retry does `compose down`, the second attempt
 *      fails the same way, and the script exits.
 *   3. CONTAINER SWAPS. A redeploy recreates frontend/kortix-api under a Caddy
 *      that keeps running; for the 10–30 s that takes every request answers
 *      502 unless the Caddyfile carries the swap-tolerance snippet.
 *
 * The guard is a container (docker:cli, host network, docker.sock and the
 * preview state dir mounted at the SAME paths as the host, so every compose
 * file path resolves) that wakes every 60 s. It never fights a deploy: while
 * the bootstrap's phase file says a deploy is in flight it only prunes disk.
 * Otherwise: prune when the disk is tight, bring the stack back up when the
 * edge is not answering, and keep Caddy swap-tolerant.
 *
 * It is installed by the bootstrap (`buildPreviewGuardInstall`) on every
 * deploy — idempotently, keyed on the script's own hash — so a recreated
 * sandbox gets it too. The deploy's own retry logic stays; the guard covers
 * the time when no deploy is running, which is almost all of the time.
 *
 * POSIX sh: it runs under busybox. Kept as one string so the bootstrap can
 * embed it in a quoted heredoc and the unit test can hand it to `sh -n`.
 */
export const PREVIEW_GUARD_CONTAINER = 'kortix-preview-guard';

/** The heredoc delimiter; the script must never contain this line. */
export const PREVIEW_GUARD_HEREDOC = 'KORTIX_PREVIEW_GUARD_EOF';

export const PREVIEW_GUARD_SCRIPT = `#!/bin/sh
# kortix-preview-guard — keeps a persistent branch environment serving.
# Written by the deploy bootstrap (tests/src/core/preview-guard.ts); edits made
# here on the box are overwritten by the next deploy.
DIR=/workspace/kortix-preview
LOG="$DIR/guard.log"
INSTANCE="\${KORTIX_PREVIEW_INSTANCE:-$(ls "$DIR/self-host" 2>/dev/null | head -1)}"
INSTDIR="$DIR/self-host/$INSTANCE"
PROJECT="kortix-$INSTANCE"
PHASE="$DIR/kortix-preview.phase"
EXIT="$DIR/kortix-preview.exit"
CADDY="$DIR/Caddyfile.preview"
EDGE="$PROJECT-preview-edge-1"
HEALTH=http://127.0.0.1:8080/v1/health
PRUNE_AT=75
RECOVER_COOLDOWN=300
last_recover=0

log() { echo "$(date '+%Y-%m-%dT%H:%M:%S') $1" >> "$LOG"; }
compose() {
  docker compose --project-name "$PROJECT" --env-file "$INSTDIR/.env" \\
    -f "$INSTDIR/docker-compose.yml" -f "$DIR/docker-compose.preview.yml" "$@"
}
# df on the bind-mounted state dir reports the HOST filesystem, not this
# container's.
disk_used() { df -P "$DIR" | awk 'NR==2 { gsub("%", "", $5); print $5 }'; }
healthy() { wget -qO- --timeout=8 "$HEALTH" 2>/dev/null | grep -q '"status":"ok"'; }
# The bootstrap removes both files at start, writes the phase as it goes, and
# writes the exit file from its EXIT trap. A phase with no exit that is younger
# than 30 min is a deploy in flight; older is one that died without its trap.
deploy_running() {
  [ -f "$PHASE" ] || return 1
  [ -f "$EXIT" ] && return 1
  case "$(cat "$PHASE" 2>/dev/null)" in ready|tests-skipped|tests) return 1 ;; esac
  [ -n "$(find "$PHASE" -mmin -30 2>/dev/null)" ]
}

prune_if_full() {
  used="$(disk_used)"
  [ -n "$used" ] && [ "$used" -ge "$PRUNE_AT" ] || return 0
  log "disk at \${used}%: pruning unreferenced images"
  # -a removes images with NO container (running, stopped or created), so the
  # current stack's images and this guard's own image are never taken.
  docker image prune -af >> "$LOG" 2>&1
  docker builder prune -af >> "$LOG" 2>&1
  log "disk now at $(disk_used)%"
}

# Caddy: hold requests through a container swap instead of 502ing. The deploy
# regenerates the Caddyfile; when the generated one already carries the
# snippet this is a no-op, otherwise it is patched in and validated BEFORE the
# edge is asked to reload it.
ensure_caddy_tolerant() {
  [ -f "$CADDY" ] || return 0
  grep -q swap_tolerant "$CADDY" && return 0
  docker inspect "$EDGE" >/dev/null 2>&1 || return 0
  tmp=/tmp/Caddyfile.tolerant
  {
    printf '(swap_tolerant) {\\n  lb_try_duration 30s\\n  lb_try_interval 250ms\\n}\\n\\n'
    sed -E \\
      -e 's/^([[:space:]]*)reverse_proxy ([a-z0-9-]+:[0-9]+)[[:space:]]*$/\\1reverse_proxy \\2 {\\n\\1  import swap_tolerant\\n\\1}/' \\
      -e 's/^([[:space:]]*)reverse_proxy ([a-z0-9-]+:[0-9]+)[[:space:]]*\\{[[:space:]]*$/\\1reverse_proxy \\2 {\\n\\1  import swap_tolerant/' \\
      "$CADDY"
  } > "$tmp"
  if docker exec -i "$EDGE" caddy validate --adapter caddyfile --config /dev/stdin < "$tmp" > /tmp/caddy-validate.log 2>&1; then
    cp "$tmp" "$CADDY"
    if docker exec "$EDGE" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >> "$LOG" 2>&1; then
      log "caddy: swap tolerance applied and reloaded"
    else
      log "caddy: reload FAILED after a valid config; file left in place"
    fi
  else
    log "caddy: patched config did not validate; edge left untouched"
  fi
}

recover() {
  now="$(date +%s)"
  [ $((now - last_recover)) -ge "$RECOVER_COOLDOWN" ] || return 0
  last_recover="$now"
  log "stack unhealthy and no deploy in flight: compose up"
  prune_if_full
  if compose up -d --wait --wait-timeout 300 >> "$LOG" 2>&1; then
    log "stack recovered"
    return 0
  fi
  log "compose up failed; clearing containers (volumes kept) and retrying"
  compose logs --no-color --tail 40 supabase-db kortix-migrate >> "$LOG" 2>&1 || true
  # Never with -v: the named volumes carry this environment's data.
  compose down --remove-orphans --timeout 30 >> "$LOG" 2>&1 || true
  sleep 10
  if compose up -d --wait --wait-timeout 300 >> "$LOG" 2>&1; then
    log "stack recovered on retry"
  else
    log "stack recovery FAILED; retrying after the cooldown"
  fi
}

log "guard started (pid $$) instance=$INSTANCE project=$PROJECT"
while true; do
  sleep 60
  prune_if_full
  if deploy_running; then continue; fi
  if healthy; then
    ensure_caddy_tolerant
    continue
  fi
  recover
done
`;

/**
 * The bash the bootstrap runs to (re)install the guard on the box, right after
 * the docker daemon is up and before anything that can fail.
 *
 * Idempotent: the container carries the script's sha256 as a label, and it is
 * recreated only when the script changed. The image is the same docker:cli
 * the self-host updater already uses, so it is present on a warm sandbox.
 */
export function buildPreviewGuardInstall(input: {
  stateDir: string;
  instance: string;
  dockerCliImage: string;
}): string {
  if (!/^[a-z0-9-]+$/.test(input.instance)) throw new Error(`invalid preview instance: ${input.instance}`);
  if (!/^[a-z0-9./:@-]+$/i.test(input.dockerCliImage)) {
    throw new Error(`invalid docker cli image: ${input.dockerCliImage}`);
  }
  if (PREVIEW_GUARD_SCRIPT.split('\n').includes(PREVIEW_GUARD_HEREDOC)) {
    throw new Error('guard script contains its own heredoc delimiter');
  }
  const guard = `${input.stateDir}/guard.sh`;
  return `printf 'guard\\n' > "$PHASE"
cat > ${guard}.tmp <<'${PREVIEW_GUARD_HEREDOC}'
${PREVIEW_GUARD_SCRIPT}${PREVIEW_GUARD_HEREDOC}
chmod 0755 ${guard}.tmp && mv ${guard}.tmp ${guard}
guard_sha="$(sha256sum ${guard} | cut -c1-16)"
running_sha="$(docker inspect --format '{{ index .Config.Labels "kortix.guard-sha" }}' ${PREVIEW_GUARD_CONTAINER} 2>/dev/null || true)"
if [ "$running_sha" != "$guard_sha" ]; then
  docker rm -f ${PREVIEW_GUARD_CONTAINER} >/dev/null 2>&1 || true
  docker run -d --name ${PREVIEW_GUARD_CONTAINER} --restart unless-stopped --network host \\
    --label "kortix.guard-sha=$guard_sha" \\
    -e KORTIX_PREVIEW_INSTANCE=${input.instance} \\
    -v /var/run/docker.sock:/var/run/docker.sock \\
    -v ${input.stateDir}:${input.stateDir} \\
    ${input.dockerCliImage} sh ${guard} >/dev/null
  echo "preview guard installed ($guard_sha)" >&2
else
  echo "preview guard already current ($guard_sha)" >&2
fi
`;
}

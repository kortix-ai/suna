/**
 * Warm (memory-state) snapshot baker.
 *
 * Daytona's experimental VM-class region (DAYTONA_WARM_TARGET) can snapshot a
 * RUNNING sandbox — full process + RAM state, not just the filesystem — via
 * `sandbox._experimental_createSnapshot`. A sandbox later created from that
 * snapshot resumes with the captured processes still alive. We exploit this to
 * pre-warm opencode: bake a snapshot where opencode's one-time DB migration is
 * done and the server is already listening, so a session boots in ~2s instead
 * of paying the cold create + 15-35s opencode startup.
 *
 * Why imperative (not a Dockerfile): the experimental region's image-build path
 * is unavailable (it can't pull built images), so we boot a STOCK base snapshot
 * and install the runtime via the sandbox's own shell — its outbound network
 * works fine (npm/apt reachable), only the Daytona image-builder is restricted.
 *
 * Validated end-to-end (2026-06): bake ~45s + snapshot ~38s (one-time, off the
 * session hot path); warm boot 2.0s with opencode already serving on the same
 * PID that was captured.
 *
 * This module bakes the opencode-warm layer. Wiring the full Kortix runtime
 * (kortix-agent + entrypoint + project clone) on top is the next step; the
 * shell sequence here mirrors the relevant RUN lines in dockerfile-layer.ts.
 */

import { config } from '../config';
import { getDaytonaWarm, warmSnapshotsEnabled } from '../shared/daytona';

// Keep in sync with OPENCODE_VERSION in snapshots/providers/daytona.ts (the
// version baked into the normal Dockerfile snapshot). Drift just means the warm
// snapshot serves a different opencode than cold boots — not a crash.
const OPENCODE_VERSION = '1.15.10';

// XDG layout matching the daemon's opencode spawn so the baked DB migration is
// found at boot (see dockerfile-layer.ts migration-bake comment).
const RUNTIME_HOME = '/opt/kortix/home';
const OPENCODE_PORT = 4096;
const XDG_EXPORTS =
  `export HOME=${RUNTIME_HOME} ` +
  `XDG_DATA_HOME=${RUNTIME_HOME}/.local/share ` +
  `XDG_CONFIG_HOME=${RUNTIME_HOME}/.config ` +
  `XDG_CACHE_HOME=${RUNTIME_HOME}/.cache ` +
  `PATH=/usr/local/bin:/usr/bin:/bin`;

const CREATE_TIMEOUT_S = 180;
const SNAPSHOT_TIMEOUT_S = 300;

export interface WarmBakeResult {
  snapshotName: string;
  baseSnapshot: string;
  bakeMs: number;
  snapshotMs: number;
}

export class WarmBakeError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'WarmBakeError';
  }
}

type Sandbox = Awaited<ReturnType<ReturnType<typeof getDaytonaWarm>['create']>>;

/** Run a multi-line script in the sandbox, base64-piped to dodge shell quoting. */
async function runScript(sb: Sandbox, script: string, timeoutS: number): Promise<{ exitCode: number; out: string }> {
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  const cmd = `echo ${b64} | base64 -d > /tmp/_kortix_bake.sh && bash /tmp/_kortix_bake.sh`;
  const r = await sb.process.executeCommand(cmd, undefined, undefined, timeoutS);
  return { exitCode: r.exitCode ?? 0, out: (r.result ?? '').trim() };
}

async function step(
  sb: Sandbox,
  label: string,
  script: string,
  timeoutS: number,
  onLog?: (line: string) => void,
): Promise<string> {
  const t = Date.now();
  const { exitCode, out } = await runScript(sb, script, timeoutS);
  const tail = out.split('\n').slice(-4).join(' | ');
  onLog?.(`[warm-bake] ${label}: exit=${exitCode} (${((Date.now() - t) / 1000).toFixed(1)}s) ${tail}`);
  if (exitCode !== 0) {
    throw new WarmBakeError(`warm-bake step "${label}" failed (exit ${exitCode}): ${tail}`);
  }
  return out;
}

/**
 * Bake a warm snapshot named `name` with opencode pre-migrated and serving in
 * RAM. Boots a throwaway builder sandbox off the stock base snapshot, installs
 * + warms the runtime, snapshots the live box, then removes the builder.
 * Idempotent at the caller's level: re-baking the same name overwrites it.
 */
export async function bakeWarmSnapshot(opts: {
  name: string;
  baseSnapshot?: string;
  onLog?: (line: string) => void;
}): Promise<WarmBakeResult> {
  if (!warmSnapshotsEnabled()) {
    throw new WarmBakeError('warm snapshots are not enabled (KORTIX_WARM_SNAPSHOT_ENABLED / DAYTONA_WARM_TARGET)');
  }
  const baseSnapshot = opts.baseSnapshot || config.DAYTONA_WARM_BASE_SNAPSHOT;
  const daytona = getDaytonaWarm();
  const onLog = opts.onLog;

  onLog?.(`[warm-bake] booting builder from ${baseSnapshot} on target "${config.DAYTONA_WARM_TARGET}"`);
  const sb = await daytona.create({ snapshot: baseSnapshot }, { timeout: CREATE_TIMEOUT_S });

  try {
    const bakeStart = Date.now();

    await step(
      sb,
      'apt nodejs/npm',
      // `sudo: unable to resolve host` is a harmless warning on these images.
      `sudo apt-get update -o Acquire::Retries=2 >/tmp/apt.log 2>&1 && ` +
        `sudo apt-get install -y --no-install-recommends nodejs npm >>/tmp/apt.log 2>&1; node -v; npm -v`,
      600,
      onLog,
    );

    await step(
      sb,
      'runtime home',
      `sudo mkdir -p ${RUNTIME_HOME} && sudo chown -R daytona:daytona /opt/kortix && echo ok`,
      60,
      onLog,
    );

    await step(
      sb,
      `npm i -g opencode@${OPENCODE_VERSION}`,
      `sudo npm install -g --no-audit --no-fund opencode-ai@${OPENCODE_VERSION} >/tmp/oc-install.log 2>&1; ` +
        `command -v opencode && opencode --version`,
      600,
      onLog,
    );

    // Migration bake: run opencode once so its sqlite migration completes and is
    // captured. Best-effort — a failure just means the cold migration path runs
    // at first real boot.
    await step(
      sb,
      'opencode migration bake',
      `${XDG_EXPORTS}
mkdir -p "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME"
opencode serve --port ${OPENCODE_PORT} --hostname 127.0.0.1 >/tmp/oc-bake.log 2>&1 &
pid=$!
for i in $(seq 1 120); do curl -s -o /dev/null -m 2 http://127.0.0.1:${OPENCODE_PORT}/ && break; sleep 1; done
sleep 2; kill $pid 2>/dev/null; sleep 1; tail -2 /tmp/oc-bake.log`,
      240,
      onLog,
    );

    // Start opencode SERVING and leave it running — this is the in-RAM state the
    // memory snapshot captures. setsid detaches it from the exec session so it
    // survives past this call.
    const startOut = await step(
      sb,
      'start opencode (persist in RAM)',
      `${XDG_EXPORTS}
setsid bash -c 'opencode serve --port ${OPENCODE_PORT} --hostname 127.0.0.1 >/tmp/oc.log 2>&1' </dev/null >/dev/null 2>&1 &
sleep 3
for i in $(seq 1 60); do curl -s -o /dev/null -m 2 http://127.0.0.1:${OPENCODE_PORT}/ && break; sleep 1; done
pgrep -f 'opencode serve' | head -1 > /tmp/oc.pid
echo "pid=$(cat /tmp/oc.pid) http=$(curl -s -o /dev/null -w '%{http_code}' -m 3 http://127.0.0.1:${OPENCODE_PORT}/)"`,
      120,
      onLog,
    );
    if (!startOut.includes('http=200')) {
      throw new WarmBakeError(`opencode did not reach HTTP 200 in the builder box: ${startOut}`);
    }
    const bakeMs = Date.now() - bakeStart;

    onLog?.(`[warm-bake] snapshotting live box → ${opts.name}`);
    const snapStart = Date.now();
    await sb._experimental_createSnapshot(opts.name, SNAPSHOT_TIMEOUT_S);
    const snapshotMs = Date.now() - snapStart;
    onLog?.(`[warm-bake] done: bake ${(bakeMs / 1000).toFixed(1)}s + snapshot ${(snapshotMs / 1000).toFixed(1)}s`);

    return { snapshotName: opts.name, baseSnapshot, bakeMs, snapshotMs };
  } finally {
    // Remove the throwaway builder box; the snapshot is independent of it.
    await sb.delete().catch((err: unknown) =>
      onLog?.(`[warm-bake] builder cleanup failed: ${err instanceof Error ? err.message : String(err)}`),
    );
  }
}

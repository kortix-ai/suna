/**
 * Warm (memory-state) snapshot baker — full Kortix runtime.
 *
 * Daytona's experimental VM-class region (DAYTONA_WARM_TARGET) can snapshot a
 * sandbox via `sandbox._experimental_createSnapshot` and create new sandboxes
 * from it in ~1.3s (vs the 8-12s cold create). That region CANNOT build
 * Dockerfile/registry images (its image-builder can't pull), so instead of the
 * normal snapshot pipeline we boot a STOCK base snapshot and install the Kortix
 * runtime imperatively over the sandbox's own (working) network egress, then
 * snapshot the result.
 *
 * The baked snapshot mirrors the Dockerfile runtime layer (dockerfile-layer.ts):
 * opencode (pre-migrated), bun, agent-browser, the kortix-agent daemon + kortix
 * CLI binaries, the agent-cli shims, and the executor-sdk. It is project- and
 * session-AGNOSTIC: the session daemon is NOT started here. A session boots from
 * this snapshot and starts `kortix-agent` post-restore with its own per-session
 * env (provisionSessionSandbox already computes it), so identity/repo/branch are
 * fresh — memory-restore would otherwise freeze the baked env.
 *
 * Validated on the experimental region (2026-06): apt+opencode+migration ~45s,
 * 75MB binary upload ~85s, snapshot ~40s (all one-time); warm create 1.3s.
 *
 * Toggle: warmSnapshotsEnabled() (KORTIX_WARM_SNAPSHOT_ENABLED + DAYTONA_WARM_TARGET).
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, createWriteStream, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, basename, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';
import { SandboxState } from '@daytonaio/sdk';
import { config } from '../config';
import { getDaytonaWarm, warmSnapshotsEnabled } from '../shared/daytona';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../..');

// Same artifact set the Dockerfile snapshot bakes (snapshots/providers/daytona.ts).
const AGENT_BIN_PATH = process.env.KORTIX_SNAPSHOT_AGENT_BIN_PATH
  || resolve(REPO_ROOT, 'apps/kortix-sandbox-agent-server/dist/kortix-agent');
const CLI_BIN_PATH = process.env.KORTIX_SNAPSHOT_CLI_BIN_PATH
  || resolve(REPO_ROOT, 'apps/cli/dist/kortix');
const ENTRYPOINT_PATH = process.env.KORTIX_SNAPSHOT_ENTRYPOINT_PATH
  || resolve(REPO_ROOT, 'apps/sandbox/entrypoint.sh');
const AGENT_CLI_SRC_PATH = process.env.KORTIX_SNAPSHOT_AGENT_CLI_PATH
  || resolve(REPO_ROOT, 'apps/sandbox/agent-cli');
const EXECUTOR_SDK_SRC_PATH = process.env.KORTIX_SNAPSHOT_EXECUTOR_SDK_PATH
  || resolve(REPO_ROOT, 'packages/executor-sdk');

// Keep in sync with snapshots/providers/daytona.ts + dockerfile-layer.ts.
const OPENCODE_VERSION = '1.15.10';
const AGENT_BROWSER_VERSION = '0.27.0';

const RUNTIME_HOME = '/opt/kortix/home';
export const OPENCODE_PORT = 4096;
export const XDG_EXPORTS =
  `export HOME=${RUNTIME_HOME} ` +
  `XDG_DATA_HOME=${RUNTIME_HOME}/.local/share ` +
  `XDG_CONFIG_HOME=${RUNTIME_HOME}/.config ` +
  `XDG_CACHE_HOME=${RUNTIME_HOME}/.cache ` +
  `PATH=/usr/local/bin:/usr/bin:/bin`;

const CREATE_TIMEOUT_S = 180;
export const SNAPSHOT_TIMEOUT_S = 300;
const UPLOAD_TIMEOUT_S = 300;

/** Spec the warm base is resized to before snapshotting — mirrors the platform
 * default sandbox spec (snapshots/providers/daytona.ts DEFAULT_*), since warm
 * boxes inherit the SNAPSHOT's resources and can't be sized at create time. */
const WARM_SPEC = {
  cpu: readPositiveIntEnv('KORTIX_DEFAULT_SANDBOX_CPU', 2),
  memory: readPositiveIntEnv('KORTIX_DEFAULT_SANDBOX_MEMORY_GB', 4),
  disk: readPositiveIntEnv('KORTIX_DEFAULT_SANDBOX_DISK_GB', 20),
};

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

// Static runtime env the normal sandbox bakes as Dockerfile `ENV` lines. The
// imperative bake can't bake image ENV, so we export these when launching the
// daemon (before sourcing the per-session env, which wins on overlap). Values
// are space/quote-free so they embed safely inside `sudo bash -c '…'`.
const RUNTIME_ENV =
  'export AGENT_BROWSER_ARGS=--no-sandbox,--disable-dev-shm-usage KORTIX_WORKSPACE=/workspace;';

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

export type WarmSandbox = Awaited<ReturnType<ReturnType<typeof getDaytonaWarm>['create']>>;
type Sandbox = WarmSandbox;

/** Run a multi-line script in the sandbox, base64-piped to dodge shell quoting. */
export async function runScript(sb: Sandbox, script: string, timeoutS: number): Promise<{ exitCode: number; out: string }> {
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  const cmd = `echo ${b64} | base64 -d > /tmp/_kortix_bake.sh && bash /tmp/_kortix_bake.sh`;
  const r = await sb.process.executeCommand(cmd, undefined, undefined, timeoutS);
  return { exitCode: r.exitCode ?? 0, out: (r.result ?? '').trim() };
}

export async function step(sb: Sandbox, label: string, script: string, timeoutS: number, onLog?: (l: string) => void): Promise<string> {
  const t = Date.now();
  const { exitCode, out } = await runScript(sb, script, timeoutS);
  onLog?.(`[warm-bake] ${label}: exit=${exitCode} (${((Date.now() - t) / 1000).toFixed(1)}s) ${out.split('\n').slice(-3).join(' | ')}`);
  if (exitCode !== 0) throw new WarmBakeError(`warm-bake step "${label}" failed (exit ${exitCode}): ${out.split('\n').slice(-4).join(' | ')}`);
  return out;
}

/**
 * Create a builder/restore box from a warm snapshot, retrying through the
 * experimental region's flakiness (creates fail outright with "internal error"
 * ~half the time, and restored boxes occasionally come up with broken egress
 * that would hang any later network step for minutes). Egress-gated; failed
 * attempts are cleaned up and their error-state corpses swept. Shared by the
 * runtime-base bake and the per-project bake.
 */
export async function createHealthyBuilder(baseSnapshot: string, onLog?: (l: string) => void): Promise<Sandbox> {
  const daytona = getDaytonaWarm();
  const BUILDER_ATTEMPTS = 6;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= BUILDER_ATTEMPTS; attempt++) {
    let box: Sandbox | null = null;
    try {
      box = await daytona.create({ snapshot: baseSnapshot }, { timeout: CREATE_TIMEOUT_S });
      // Health-gate the box before committing to a multi-minute bake: cheap
      // probe — outbound HTTPS to the npm registry must answer.
      const probe = await box.process.executeCommand(
        `curl -s -o /dev/null -m 8 -w '%{http_code}' https://registry.npmjs.org/ || echo 000`,
        undefined,
        undefined,
        20,
      );
      if (!(probe.result ?? '').includes('200')) {
        throw new Error(`builder egress unhealthy (npm registry probe: ${(probe.result ?? '').trim() || 'no response'})`);
      }
      return box;
    } catch (err) {
      lastErr = err;
      onLog?.(
        `[warm-bake] builder attempt ${attempt}/${BUILDER_ATTEMPTS} failed: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      if (box) await box.delete().catch(() => {});
      // A create-throw leaves an error-state box behind org-side (we never got
      // a handle). Sweep them so the dashboard doesn't fill with corpses.
      void reapErroredWarmBoxes(baseSnapshot, onLog);
      await new Promise((r) => setTimeout(r, 2_000 * attempt));
    }
  }
  throw new WarmBakeError(
    `builder create failed after ${BUILDER_ATTEMPTS} attempts: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
    lastErr,
  );
}

/** Gzip a file at max compression (same as the Dockerfile-snapshot builder). */
async function gzipFile(sourcePath: string, targetPath: string): Promise<void> {
  await pipeline(createReadStream(sourcePath), createGzip({ level: 9 }), createWriteStream(targetPath));
}

/**
 * Stage the runtime artifacts into a single gzipped tarball on the local disk:
 * gzipped binaries + entrypoint + the agent-cli and executor-sdk source trees.
 * Returns the tarball path; caller deletes the temp dir.
 *
 * No shell is involved: gzip/copy happen in-process and `tar` is invoked with
 * an argument ARRAY (execFileSync without a shell), so the artifact paths —
 * which can come from KORTIX_SNAPSHOT_* env vars — are never interpreted as
 * shell syntax (CodeQL: indirect uncontrolled command line).
 */
async function stageBuildContext(): Promise<{ tarball: string; cleanup: () => void }> {
  for (const [p, hint] of [
    [AGENT_BIN_PATH, 'KORTIX_SNAPSHOT_AGENT_BIN_PATH'],
    [CLI_BIN_PATH, 'KORTIX_SNAPSHOT_CLI_BIN_PATH'],
    [ENTRYPOINT_PATH, 'KORTIX_SNAPSHOT_ENTRYPOINT_PATH'],
  ] as const) {
    try {
      if (!statSync(p).isFile()) throw new Error('not a file');
    } catch {
      throw new WarmBakeError(`required artifact missing: ${p} (set ${hint} or run \`bun run build\`)`);
    }
  }
  const dir = mkdtempSync(join(tmpdir(), 'kortix-warm-ctx-'));
  const tarball = join(dir, 'kortix-runtime-ctx.tar.gz');
  const ctx = join(dir, 'ctx');
  mkdirSync(ctx);
  await gzipFile(AGENT_BIN_PATH, join(ctx, 'kortix-agent.gz'));
  await gzipFile(CLI_BIN_PATH, join(ctx, 'kortix.gz'));
  copyFileSync(ENTRYPOINT_PATH, join(ctx, 'kortix-entrypoint'));
  execFileSync('tar', ['czf', join(ctx, 'agent-cli.tar.gz'), '-C', dirname(AGENT_CLI_SRC_PATH), basename(AGENT_CLI_SRC_PATH)], { stdio: 'pipe' });
  execFileSync('tar', ['czf', join(ctx, 'executor-sdk.tar.gz'), '-C', dirname(EXECUTOR_SDK_SRC_PATH), basename(EXECUTOR_SDK_SRC_PATH)], { stdio: 'pipe' });
  execFileSync('tar', ['czf', tarball, '-C', ctx, '.'], { stdio: 'pipe' });
  return { tarball, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Pick the snapshot the BUILDER box boots from, preferring one that is actually
 * bootable in the warm region. Daytona's experimental region can only reliably
 * boot snapshots CREATED in it (stock/shared snapshots intermittently fail with
 * "Region not found" despite their region metadata) — so each bake self-hosts:
 * it boots the PREVIOUS warm base (always region-local, newest first), refreshes
 * the runtime on top, and snapshots under the new name. The configured stock
 * base is only the genesis fallback for a brand-new org/region.
 */
async function resolveBuilderBaseSnapshot(onLog?: (l: string) => void): Promise<string> {
  try {
    const { listDaytonaSnapshots } = await import('../shared/daytona');
    const warmRegion = config.DAYTONA_WARM_TARGET;
    const candidates = (await listDaytonaSnapshots())
      .filter(
        (s) =>
          s.name.startsWith(WARM_BASE_PREFIX) &&
          s.state === 'active' &&
          s.regionIds.includes(warmRegion),
      )
      .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
    if (candidates.length > 0) {
      onLog?.(`[warm-bake] builder base: previous warm base ${candidates[0].name} (region-local)`);
      return candidates[0].name;
    }
  } catch (err) {
    onLog?.(`[warm-bake] builder-base lookup failed, using stock base: ${err instanceof Error ? err.message : String(err)}`);
  }
  return config.DAYTONA_WARM_BASE_SNAPSHOT;
}

/**
 * Bake a full-runtime warm snapshot named `name`. Boots a throwaway builder
 * (previous warm base if available, else the stock base), installs/refreshes
 * the Kortix runtime + uploads the binaries, snapshots the live box, then
 * removes the builder.
 */
export async function bakeWarmSnapshot(opts: {
  name: string;
  baseSnapshot?: string;
  onLog?: (line: string) => void;
}): Promise<WarmBakeResult> {
  if (!warmSnapshotsEnabled()) {
    throw new WarmBakeError('warm snapshots are not enabled (KORTIX_WARM_SNAPSHOT_ENABLED / DAYTONA_WARM_TARGET)');
  }
  const onLog = opts.onLog;
  const baseSnapshot = opts.baseSnapshot || (await resolveBuilderBaseSnapshot(onLog));
  const daytona = getDaytonaWarm();

  const { tarball, cleanup } = await stageBuildContext();
  onLog?.(`[warm-bake] staged build context (${(statSync(tarball).size / 1048576).toFixed(1)} MB)`);

  onLog?.(`[warm-bake] booting builder from ${baseSnapshot} on target "${config.DAYTONA_WARM_TARGET}"`);
  const sb = await createHealthyBuilder(baseSnapshot, onLog);

  try {
    const bakeStart = Date.now();

    // Restored boxes intermittently come up with broken IPv6 routing: tiny
    // requests pass (curl happy-eyeballs falls back to v4) but Node/npm
    // downloads hang for minutes on v6. Prefer IPv4 system-wide before any
    // network-touching step.
    await step(sb, 'prefer ipv4',
      `grep -q '^precedence ::ffff:0:0/96 100' /etc/gai.conf 2>/dev/null || ` +
        `echo 'precedence ::ffff:0:0/96 100' | sudo tee -a /etc/gai.conf >/dev/null; echo ok`,
      30, onLog);

    // Every install below is SKIPPED when its pin is already satisfied — the
    // self-hosted builder (previous warm base) usually has identical pins, so
    // the common rebake (only the kortix binaries changed) touches the network
    // as little as possible.
    await step(sb, 'apt runtime deps',
      `if command -v node >/dev/null && command -v git >/dev/null && command -v tmux >/dev/null && command -v ip >/dev/null && command -v arping >/dev/null; then
  echo "skip (already installed)"; node -v; npm -v
else
  sudo apt-get update -o Acquire::Retries=2 >/tmp/apt.log 2>&1
  sudo apt-get install -y --no-install-recommends ca-certificates curl git gzip nodejs npm unzip tmux iproute2 iputils-arping >>/tmp/apt.log 2>&1
  node -v; npm -v
fi`,
      600, onLog);

    await step(sb, 'runtime dirs',
      `sudo mkdir -p ${RUNTIME_HOME} /opt/kortix/apps/sandbox /opt/kortix/packages /workspace /ephemeral/kortix-master/opencode && ` +
        `sudo chown -R daytona:daytona /opt/kortix /workspace /ephemeral && echo ok`,
      60, onLog);

    await step(sb, `opencode@${OPENCODE_VERSION}`,
      `if [ "$(opencode --version 2>/dev/null)" = "${OPENCODE_VERSION}" ]; then
  echo "skip (pin satisfied)"; opencode --version
else
  sudo npm install -g --no-audit --no-fund opencode-ai@${OPENCODE_VERSION} >/tmp/oc-install.log 2>&1
  command -v opencode && opencode --version
fi`,
      600, onLog);

    await step(sb, 'opencode migration bake',
      `${XDG_EXPORTS}
mkdir -p "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME"
opencode serve --port ${OPENCODE_PORT} --hostname 127.0.0.1 >/tmp/oc-bake.log 2>&1 &
pid=$!
for i in $(seq 1 120); do curl -s -o /dev/null -m 2 http://127.0.0.1:${OPENCODE_PORT}/ && break; sleep 1; done
sleep 2; kill $pid 2>/dev/null; sleep 1; tail -2 /tmp/oc-bake.log`,
      240, onLog);

    await step(sb, 'bun + agent-browser',
      `${XDG_EXPORTS}
if ! command -v bun >/dev/null; then
  curl -fsSL https://bun.com/install | bash >/tmp/bun.log 2>&1
  sudo install -m 755 ${RUNTIME_HOME}/.bun/bin/bun /usr/local/bin/bun 2>/dev/null || sudo install -m 755 "$HOME/.bun/bin/bun" /usr/local/bin/bun
fi
bun --version
mkdir -p /opt/kortix/home/.bun/install/cache /opt/kortix/opencode-config-deps
cd /opt/kortix/opencode-config-deps
deps='{"name":"kortix-opencode-config","private":true,"dependencies":{"@mendable/firecrawl-js":"^4.25.1","@tavily/core":"^0.7.3","replicate":"^1.4.0"}}'
if [ "$(cat package.json 2>/dev/null)" = "$deps" ] && [ -d node_modules ]; then
  echo "config-deps: skip (unchanged)"
else
  printf '%s' "$deps" > package.json
  HOME=/opt/kortix/home BUN_INSTALL_CACHE_DIR=/opt/kortix/home/.bun/install/cache bun install >/tmp/cfgdeps.log 2>&1
fi
if [ "$(agent-browser --version 2>/dev/null | grep -oE '[0-9.]+$')" = "${AGENT_BROWSER_VERSION}" ]; then
  echo "agent-browser: skip (pin satisfied)"
else
  sudo npm install -g --no-audit --no-fund agent-browser@${AGENT_BROWSER_VERSION} >/tmp/ab.log 2>&1
fi
agent-browser --version`,
      600, onLog);

    // Upload + install the Kortix binaries + source trees.
    onLog?.(`[warm-bake] uploading runtime context ...`);
    const upStart = Date.now();
    await sb.fs.uploadFile(tarball, '/tmp/kortix-ctx.tar.gz', UPLOAD_TIMEOUT_S);
    onLog?.(`[warm-bake] uploaded in ${((Date.now() - upStart) / 1000).toFixed(1)}s`);

    await step(sb, 'install kortix runtime',
      `set -e
mkdir -p /tmp/ctx && tar xzf /tmp/kortix-ctx.tar.gz -C /tmp/ctx
# The builder may be a PREVIOUS warm base (self-hosted bake) — clear the source
# trees first so files removed upstream don't linger (a stale agent-cli script
# would get re-linked as a shim by install-shims.sh).
sudo rm -rf /opt/kortix/apps/sandbox/agent-cli /opt/kortix/packages/executor-sdk
# sudo + '>' redirect would run the redirect as the non-root shell (denied);
# pipe into 'sudo tee' so the privileged write lands in /usr/local/bin.
gunzip -c /tmp/ctx/kortix-agent.gz | sudo tee /usr/local/bin/kortix-agent >/dev/null
gunzip -c /tmp/ctx/kortix.gz | sudo tee /usr/local/bin/kortix >/dev/null
sudo cp /tmp/ctx/kortix-entrypoint /usr/local/bin/kortix-entrypoint
sudo tar xzf /tmp/ctx/agent-cli.tar.gz -C /opt/kortix/apps/sandbox/
sudo tar xzf /tmp/ctx/executor-sdk.tar.gz -C /opt/kortix/packages/
sudo chmod +x /usr/local/bin/kortix-agent /usr/local/bin/kortix /usr/local/bin/kortix-entrypoint /opt/kortix/apps/sandbox/agent-cli/install-shims.sh
sudo bash /opt/kortix/apps/sandbox/agent-cli/install-shims.sh /opt/kortix/apps/sandbox/agent-cli >/tmp/shims.log 2>&1
sudo chown -R daytona:daytona /opt/kortix
rm -rf /tmp/ctx /tmp/kortix-ctx.tar.gz
kortix --version`,
      300, onLog);

    const bakeMs = Date.now() - bakeStart;

    // Resize the builder to the platform default spec BEFORE snapshotting.
    // Sandboxes created from a snapshot inherit ITS resources and the SDK's
    // create-from-snapshot takes no resources param — without this every warm
    // session runs at the stock base's 1 vCPU / 1 GiB / 3 GiB instead of the
    // 2 / 4 / 20 a cold session gets (verified live: nproc=1, 984 MB RAM).
    // Disk resize requires a stopped sandbox, so stop → resize → start; on the
    // VM-class region stop/start is pause/resume, and nothing session-specific
    // is running yet, so this is safe mid-bake. Best-effort: a failure keeps
    // the small spec (warm still works, just underpowered) — but the box MUST
    // be running again before the memory snapshot.
    try {
      onLog?.(`[warm-bake] resizing builder to cpu=${WARM_SPEC.cpu} mem=${WARM_SPEC.memory}GiB disk=${WARM_SPEC.disk}GiB`);
      await sb.stop(120);
      await sb.resize({ cpu: WARM_SPEC.cpu, memory: WARM_SPEC.memory, disk: WARM_SPEC.disk }, 300);
      await sb.start(180);
      const check = await runScript(sb, `echo "nproc=$(nproc) mem_mb=$(free -m | awk '/^Mem:/{print $2}')"`, 30);
      onLog?.(`[warm-bake] post-resize: ${check.out.trim()}`);
    } catch (err) {
      onLog?.(`[warm-bake] builder resize failed (continuing at base spec): ${err instanceof Error ? err.message : String(err)}`);
      // The snapshot needs a RUNNING box — make sure we're back up.
      await sb.start(180).catch(() => {});
    }

    onLog?.(`[warm-bake] runtime installed in ${(bakeMs / 1000).toFixed(1)}s; snapshotting → ${opts.name}`);
    const snapStart = Date.now();
    await sb._experimental_createSnapshot(opts.name, SNAPSHOT_TIMEOUT_S);
    const snapshotMs = Date.now() - snapStart;
    onLog?.(`[warm-bake] done: bake ${(bakeMs / 1000).toFixed(1)}s + snapshot ${(snapshotMs / 1000).toFixed(1)}s`);

    return { snapshotName: opts.name, baseSnapshot, bakeMs, snapshotMs };
  } finally {
    cleanup();
    await sb.delete().catch((err: unknown) =>
      onLog?.(`[warm-bake] builder cleanup failed: ${err instanceof Error ? err.message : String(err)}`),
    );
  }
}

// ─── Warm base manager ───────────────────────────────────────────────────────
// One shared, project-agnostic warm base per RUNTIME IDENTITY. The name is
// content-addressed off the same runtime-artifact fingerprint the normal
// snapshot builder uses (SANDBOX_VERSION + runtime layer + opencode/agent-
// browser pins + runtime source trees), so a new release deploys → new
// fingerprint → new name → the startup kick bakes a fresh base, and sessions
// never boot last release's binaries. Old bases are reaped after a successful
// bake (see reapStaleWarmBases).
const WARM_BASE_PREFIX = 'kortix-warm-runtime-';

/**
 * Deterministic, content-addressed name of the current warm base snapshot.
 * Async because the runtime fingerprint hashes the runtime source trees on
 * first call (cached for the process lifetime afterwards).
 */
export async function warmBaseSnapshotName(): Promise<string> {
  const { currentRuntimeArtifactFingerprint } = await import('./templates');
  const fingerprint = await currentRuntimeArtifactFingerprint();
  const hash = createHash('sha256').update(fingerprint).digest('hex').slice(0, 12);
  return `${WARM_BASE_PREFIX}${hash}`;
}

// In-process dedup so concurrent session boots + the startup kick collapse to one bake.
let warmBaseBuildInFlight: Promise<void> | null = null;

// After a warm CREATE fails (e.g. the experimental region was revoked org-side
// — snapshot lookups still succeed, so name resolution alone can't detect it),
// pause the warm path so sessions go straight to the normal route instead of
// paying a doomed warm attempt each. Self-heals after the cooldown.
const WARM_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;
let warmPathPausedUntil = 0;

/** Called by the session provisioner when a warm create fell back. */
export function noteWarmPathFailure(): void {
  warmPathPausedUntil = Date.now() + WARM_FAILURE_COOLDOWN_MS;
}

/** Snapshot state, lowercased ('' when null). */
function snapState(snap: unknown): string {
  return String((snap as { state?: string } | null)?.state ?? '').toLowerCase();
}

/**
 * Usable = active AND bootable in the configured warm region. The name carries
 * no region, so after a DAYTONA_WARM_TARGET switch the old-region snapshot
 * still reads `active` — without this check no bake would ever kick and every
 * warm create would fail into the cooldown loop forever. regionIds is read
 * defensively (older API responses may omit it → assume ok).
 */
export function warmBaseUsable(snap: unknown): boolean {
  if (snapState(snap) !== 'active') return false;
  const regions = (snap as { regionIds?: unknown } | null)?.regionIds;
  return !Array.isArray(regions) || regions.includes(config.DAYTONA_WARM_TARGET);
}

/**
 * Is the warm base ready to boot sessions from? Returns its name if the snapshot
 * is active on the warm target; otherwise kicks a background bake (deduped) and
 * returns null so the caller falls back to the normal Dockerfile path this time.
 * Never throws — a warm-path failure must never block session creation.
 */
export async function ensureWarmBaseReady(onLog?: (l: string) => void): Promise<string | null> {
  if (!warmSnapshotsEnabled()) return null;
  if (Date.now() < warmPathPausedUntil) return null;
  try {
    const name = await warmBaseSnapshotName();
    const snap = await getDaytonaWarm().snapshot.get(name);
    if (warmBaseUsable(snap)) return name;
  } catch {
    // fingerprint failed / not found / transient → fall through to bake
  }
  kickWarmBaseBuild(onLog);
  return null;
}

/** Fire-and-forget bake of the warm base if missing. Idempotent + deduped. */
export function kickWarmBaseBuild(onLog?: (l: string) => void): void {
  if (!warmSnapshotsEnabled() || warmBaseBuildInFlight) return;
  const log = onLog ?? ((l: string) => console.log(l));
  warmBaseBuildInFlight = (async () => {
    try {
      const name = await warmBaseSnapshotName();
      const existing = await getDaytonaWarm().snapshot.get(name).catch(() => null);
      if (warmBaseUsable(existing)) {
        await reapStaleWarmBases(name, log);
        return;
      }
      const state = snapState(existing);
      if (state === 'building' || state === 'pulling' || state === 'pending') {
        // Another instance is mid-bake on this name — don't race or sabotage it.
        log(`[warm-bake] warm base ${name} is ${state} elsewhere — waiting`);
        return;
      }
      if (existing) {
        // The CURRENT name exists but is unusable (wrong region after a target
        // switch, or error/build_failed from a crashed bake). The re-bake would
        // collide on the name, so clear it first.
        log(`[warm-bake] warm base ${name} exists but is unusable (state=${state || 'unknown'}) — deleting before rebake`);
        await getDaytonaWarm().snapshot.delete(existing as never).catch((err: unknown) =>
          log(`[warm-bake] pre-bake delete failed: ${err instanceof Error ? err.message : String(err)}`),
        );
      }
      log(`[warm-bake] baking warm base ${name} ...`);
      await bakeWarmSnapshot({ name, onLog: log });
      log(`[warm-bake] warm base ${name} ready`);
      await reapStaleWarmBases(name, log);
    } catch (err) {
      log(`[warm-bake] warm base bake failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      warmBaseBuildInFlight = null;
    }
  })();
}

/**
 * Delete ERRORED sandboxes left behind by failed warm creates. When the
 * experimental region fails a create ("Sandbox failed to start: internal
 * error"), the SDK throws without ever handing us the box — but the box still
 * exists org-side in `error` state and lingers in the dashboard forever.
 * Targeted by snapshot name + error state so we never touch live sandboxes.
 * Best-effort and bounded; safe to fire-and-forget.
 *
 * With no `snapshotName`, sweeps errored boxes for EVERY `kortix-warm-runtime-*`
 * base — used by the periodic warm-pool reconcile, since the opportunistic
 * after-a-failed-create reap can't keep up on a busy environment (each failed
 * create leaves a fresh corpse) and misses entirely across process restarts.
 */
export async function reapErroredWarmBoxes(snapshotName?: string, log?: (l: string) => void): Promise<number> {
  if (!warmSnapshotsEnabled()) return 0;
  let reaped = 0;
  try {
    const daytona = getDaytonaWarm();
    const query = snapshotName
      ? { states: [SandboxState.ERROR], snapshots: [snapshotName] }
      : { states: [SandboxState.ERROR] };
    for await (const box of daytona.list(query)) {
      if (!snapshotName && !(box.snapshot ?? '').startsWith(WARM_BASE_PREFIX)) continue;
      try {
        await box.delete();
        reaped++;
      } catch {
        /* already gone / transient — keep going */
      }
      if (reaped >= 25) break; // bound a single pass
    }
    if (reaped > 0) log?.(`[warm-bake] reaped ${reaped} errored warm box(es) for ${snapshotName ?? 'all warm bases'}`);
  } catch (err) {
    log?.(`[warm-bake] errored-box reap skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
  return reaped;
}

/**
 * Age a warm base must reach before it can be reaped by an environment that
 * doesn't own it. Several environments share one Daytona org (laptops, dev,
 * prod) and each computes its OWN content-addressed base name — without a
 * grace window they'd delete each other's bases on every boot, forcing
 * pointless rebakes. A week comfortably outlives any active base while still
 * draining truly dead releases from the 100/org snapshot quota.
 */
const WARM_BASE_REAP_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Delete warm bases from OLD runtime identities. Names are namespaced under
 * `kortix-warm-runtime-`, so anything in that namespace that isn't the current
 * name AND is older than the grace window is a dead release's base. Best-effort:
 * skipped entirely when the org listing fails (never delete based on a partial
 * view).
 */
async function reapStaleWarmBases(currentName: string, log: (l: string) => void): Promise<void> {
  try {
    const { listDaytonaSnapshots, deleteDaytonaSnapshotById } = await import('../shared/daytona');
    const all = await listDaytonaSnapshots();
    const cutoff = Date.now() - WARM_BASE_REAP_MIN_AGE_MS;
    const stale = all.filter(
      (s) =>
        s.name.startsWith(WARM_BASE_PREFIX) &&
        s.name !== currentName &&
        // No createdAt → can't prove it's old → keep it.
        !!s.createdAt &&
        new Date(s.createdAt).getTime() < cutoff,
    );
    for (const snap of stale) {
      const ok = await deleteDaytonaSnapshotById(snap.id);
      log(`[warm-bake] reaped stale warm base ${snap.name}: ${ok ? 'ok' : 'failed'}`);
    }
  } catch (err) {
    log(`[warm-bake] stale warm-base reap skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Build the per-session env-file + daemon-start commands for a warm sandbox.
 * Daytona's executeCommand env param does NOT propagate, and memory-restore
 * freezes baked env, so we write the session identity to a file and start the
 * daemon sourcing it. Exported for the Daytona provider's warm create path.
 */
export function warmDaemonStartCommands(env: Record<string, string>): { writeEnv: string; startDaemon: string } {
  const sh = (v: string) => `'${String(v).replace(/'/g, `'\\''`)}'`;
  const envFile = Object.entries(env).map(([k, v]) => `export ${k}=${sh(v)}`).join('\n');
  const b64 = Buffer.from(envFile, 'utf8').toString('base64');
  return {
    writeEnv: `echo ${b64} | base64 -d | sudo tee /opt/kortix/session.env >/dev/null && sudo chmod 600 /opt/kortix/session.env && echo wrote`,
    // Run the daemon as ROOT, matching the normal Kortix sandbox (Dockerfile
    // `USER root`). The entrypoint anchors cwd at `/` and the daemon creates its
    // clone work-tree relative to cwd (`/.kortix-clone-…`); the base image's
    // default `daytona` user can't write to root-owned `/`, so the clone fails
    // with EACCES. sudo (passwordless on these images) restores parity.
    //
    // RUNTIME_ENV mirrors the static `ENV` lines the Dockerfile bakes (which the
    // imperative bake can't bake into the image) — exported first so the
    // per-session `session.env` still wins on any overlap. Notably
    // AGENT_BROWSER_ARGS, without which the agent's browser tool crashes in a
    // sandboxed container.
    startDaemon:
      `setsid sudo bash -c '${RUNTIME_ENV} set -a; source /opt/kortix/session.env; set +a; cd /; exec /usr/local/bin/kortix-entrypoint' ` +
      `</dev/null >/tmp/kortix-agent.log 2>&1 & echo started`,
  };
}

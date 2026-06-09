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
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
const OPENCODE_PORT = 4096;
const XDG_EXPORTS =
  `export HOME=${RUNTIME_HOME} ` +
  `XDG_DATA_HOME=${RUNTIME_HOME}/.local/share ` +
  `XDG_CONFIG_HOME=${RUNTIME_HOME}/.config ` +
  `XDG_CACHE_HOME=${RUNTIME_HOME}/.cache ` +
  `PATH=/usr/local/bin:/usr/bin:/bin`;

const CREATE_TIMEOUT_S = 180;
const SNAPSHOT_TIMEOUT_S = 300;
const UPLOAD_TIMEOUT_S = 300;

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

async function step(sb: Sandbox, label: string, script: string, timeoutS: number, onLog?: (l: string) => void): Promise<string> {
  const t = Date.now();
  const { exitCode, out } = await runScript(sb, script, timeoutS);
  onLog?.(`[warm-bake] ${label}: exit=${exitCode} (${((Date.now() - t) / 1000).toFixed(1)}s) ${out.split('\n').slice(-3).join(' | ')}`);
  if (exitCode !== 0) throw new WarmBakeError(`warm-bake step "${label}" failed (exit ${exitCode}): ${out.split('\n').slice(-4).join(' | ')}`);
  return out;
}

/**
 * Stage the runtime artifacts into a single gzipped tarball on the local disk:
 * gzipped binaries + entrypoint + the agent-cli and executor-sdk source trees.
 * Returns the tarball path; caller deletes the temp dir.
 */
function stageBuildContext(): { tarball: string; cleanup: () => void } {
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
  // One bash invocation: assemble ctx/ then tar it. -I 'gzip -9' keeps the
  // binaries small (~37MB each) so the single upload stays reasonable.
  const script = [
    'set -e',
    `mkdir -p "${ctx}"`,
    `gzip -9 -c "${AGENT_BIN_PATH}" > "${ctx}/kortix-agent.gz"`,
    `gzip -9 -c "${CLI_BIN_PATH}" > "${ctx}/kortix.gz"`,
    `cp "${ENTRYPOINT_PATH}" "${ctx}/kortix-entrypoint"`,
    `tar czf "${ctx}/agent-cli.tar.gz" -C "${dirname(AGENT_CLI_SRC_PATH)}" "${basename(AGENT_CLI_SRC_PATH)}"`,
    `tar czf "${ctx}/executor-sdk.tar.gz" -C "${dirname(EXECUTOR_SDK_SRC_PATH)}" "${basename(EXECUTOR_SDK_SRC_PATH)}"`,
    `tar czf "${tarball}" -C "${ctx}" .`,
  ].join('\n');
  execFileSync('bash', ['-c', script], { stdio: 'pipe' });
  return { tarball, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Bake a full-runtime warm snapshot named `name`. Boots a throwaway builder off
 * the stock base snapshot, installs the Kortix runtime + uploads the binaries,
 * snapshots the live box, then removes the builder.
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

  const { tarball, cleanup } = stageBuildContext();
  onLog?.(`[warm-bake] staged build context (${(statSync(tarball).size / 1048576).toFixed(1)} MB)`);

  onLog?.(`[warm-bake] booting builder from ${baseSnapshot} on target "${config.DAYTONA_WARM_TARGET}"`);
  const sb = await daytona.create({ snapshot: baseSnapshot }, { timeout: CREATE_TIMEOUT_S });

  try {
    const bakeStart = Date.now();

    await step(sb, 'apt runtime deps',
      `sudo apt-get update -o Acquire::Retries=2 >/tmp/apt.log 2>&1 && ` +
        `sudo apt-get install -y --no-install-recommends ca-certificates curl git gzip nodejs npm unzip tmux iproute2 iputils-arping >>/tmp/apt.log 2>&1; ` +
        `node -v; npm -v`,
      600, onLog);

    await step(sb, 'runtime dirs',
      `sudo mkdir -p ${RUNTIME_HOME} /opt/kortix/apps/sandbox /opt/kortix/packages /workspace /ephemeral/kortix-master/opencode && ` +
        `sudo chown -R daytona:daytona /opt/kortix /workspace /ephemeral && echo ok`,
      60, onLog);

    await step(sb, `npm i -g opencode@${OPENCODE_VERSION}`,
      `sudo npm install -g --no-audit --no-fund opencode-ai@${OPENCODE_VERSION} >/tmp/oc-install.log 2>&1; command -v opencode && opencode --version`,
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
curl -fsSL https://bun.com/install | bash >/tmp/bun.log 2>&1
sudo install -m 755 ${RUNTIME_HOME}/.bun/bin/bun /usr/local/bin/bun 2>/dev/null || sudo install -m 755 "$HOME/.bun/bin/bun" /usr/local/bin/bun
bun --version
mkdir -p /opt/kortix/home/.bun/install/cache /opt/kortix/opencode-config-deps
cd /opt/kortix/opencode-config-deps
printf '{"name":"kortix-opencode-config","private":true,"dependencies":{"@mendable/firecrawl-js":"^4.25.1","@tavily/core":"^0.7.3","replicate":"^1.4.0"}}' > package.json
HOME=/opt/kortix/home BUN_INSTALL_CACHE_DIR=/opt/kortix/home/.bun/install/cache bun install >/tmp/cfgdeps.log 2>&1
sudo npm install -g --no-audit --no-fund agent-browser@${AGENT_BROWSER_VERSION} >/tmp/ab.log 2>&1
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

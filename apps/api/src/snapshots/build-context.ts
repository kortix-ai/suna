/**
 * Shared build-context staging for sandbox snapshots.
 *
 * Both providers build the SAME image: the user's Dockerfile + the Kortix
 * runtime layer (agent binary + CLI + entrypoint + slack-cli +
 * opencode/agent-browser). Daytona ships this context to its build service via
 * `Image.fromDockerfile(ctx)`; Platinum ships it to `POST /v1/templates/
 * from-build`. Staging the context here — once — guarantees the produced image
 * is byte-identical across providers and keeps the artifact paths in one place.
 *
 * Extracted verbatim from the Daytona adapter (no behaviour change); see
 * snapshots/providers/daytona.ts (Daytona) + snapshots/providers/platinum.ts.
 */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  copyFile,
  cp,
  chmod,
  readdir,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile as writeFileFs,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createGzip } from 'node:zlib';
import { AGENT_BROWSER_VERSION, OPENCODE_VERSION } from '@kortix/shared';
import { buildFastSandboxDockerfile, buildMetaSandboxDockerfile } from '@kortix/shared/sandbox';
import { gatewayModelCatalog } from '../llm-gateway/models/catalog-models';
import { managedSkillOverlayFiles } from '../runtime-assets/managed-skills';
import { appCaddyBinaryPath, appdBinaryPath } from '../apps/runtime-artifacts';
import { buildStarterFiles, DEFAULT_STARTER_TEMPLATE_ID } from '../projects/starter';
import { assertCliArtifactAttested } from './cli-artifact-attestation';
import { buildLayeredDockerfile } from './dockerfile-layer';
import { stageOpencodeConfigTree } from './opencode-config-stage';
import { stagingTarArgs, stagingTarEnv } from './staging-tar';

const execFileAsyncBC = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../..');
// These artifact paths are read LAZILY (per call, not as module-load consts).
// build-context is imported once and shared across the whole `bun test` process;
// tests override KORTIX_SNAPSHOT_* per suite, so module-load consts let the
// first-imported suite's fixtures win and break sibling suites in a combined run.
// In production the env is set once, so reading per-call is behaviour-neutral.
const agentBinPath = () => process.env.KORTIX_SNAPSHOT_AGENT_BIN_PATH
  || resolve(REPO_ROOT, 'apps/kortix-sandbox-agent-server/dist/kortix-agent');
const cliBinPath = () => process.env.KORTIX_SNAPSHOT_CLI_BIN_PATH
  || resolve(REPO_ROOT, 'apps/cli/dist/kortix');
const cliAttestationPath = () => process.env.KORTIX_SNAPSHOT_CLI_ATTESTATION_PATH
  || resolve(REPO_ROOT, 'apps/cli/dist/kortix-connectors-runtime.attestation.json');
const entrypointSrcPath = () => process.env.KORTIX_SNAPSHOT_ENTRYPOINT_PATH
  || resolve(REPO_ROOT, 'apps/sandbox/entrypoint.sh');
const slackCliSrcPath = () => process.env.KORTIX_SNAPSHOT_SLACK_CLI_PATH
  || resolve(REPO_ROOT, 'apps/sandbox/slack-cli');
// Canonical starter `.kortix/opencode` surface (pty plugin + standard tools +
// skills). Staged into the context so the layer can warm a real opencode project
// instance at build time (see dockerfile-layer.ts `opencodeConfigPath`).
const opencodeConfigSrcPath = () => process.env.KORTIX_SNAPSHOT_OPENCODE_CONFIG_PATH
  || resolve(REPO_ROOT, 'packages/starter/templates/base/.kortix/opencode');
const opencodeWarmupSrcPath = () => process.env.KORTIX_SNAPSHOT_OPENCODE_WARMUP_PATH
  || resolve(REPO_ROOT, 'apps/sandbox/opencode-warmup.sh');
const machineDocSrcPath = () => process.env.KORTIX_SNAPSHOT_MACHINE_DOC_PATH
  || resolve(REPO_ROOT, 'apps/sandbox/MACHINE.md');
const fastMachineDocSrcPath = () => process.env.KORTIX_SNAPSHOT_FAST_MACHINE_DOC_PATH
  || resolve(REPO_ROOT, 'apps/sandbox/MACHINE.fast.md');
const lazyToolsSrcPath = () => process.env.KORTIX_SNAPSHOT_LAZY_TOOLS_PATH
  || resolve(REPO_ROOT, 'apps/sandbox/lazy-tools');
const runtimeVersionsSrcPath = () => process.env.KORTIX_SNAPSHOT_RUNTIME_VERSIONS_PATH
  || resolve(REPO_ROOT, 'packages/shared/src/runtime-versions.json');

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/** Default resource spec, shared by every provider when a template omits one. */
export const DEFAULT_CPU = readPositiveIntEnv('KORTIX_DEFAULT_SANDBOX_CPU', 2);
export const DEFAULT_MEMORY_GB = readPositiveIntEnv('KORTIX_DEFAULT_SANDBOX_MEMORY_GB', 6);
export const DEFAULT_DISK_GB = readPositiveIntEnv('KORTIX_DEFAULT_SANDBOX_DISK_GB', 20);

/** The entrypoint baked into every snapshot (provider default). */
export const KORTIX_ENTRYPOINT = '/usr/local/bin/kortix-entrypoint';

export interface StagedContext {
  /** Temp dir holding the composed Dockerfile + staged artifacts. Caller removes it. */
  contextDir: string;
  /** Absolute path to the composed Dockerfile inside contextDir. */
  composedPath: string;
  /** Basename of the Dockerfile (for `-f`). */
  dockerfileName: string;
}

async function removeStagedContextOnFailure<T>(
  contextDir: string,
  stage: () => Promise<T>,
): Promise<T> {
  try {
    return await stage();
  } catch (error) {
    await rm(contextDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Stage one provider-neutral Kortix App build context. The user's Dockerfile
 * remains the base. This function adds only the supervisor, ingress binary,
 * and immutable non-secret runtime specification. Provider credentials and App
 * secrets never enter the build context.
 */
export async function stageAppBuildContext(
  snapshotName: string,
  userDockerfile: string,
  appContext: { sourceDir?: string; runtimeSpec: Record<string, unknown> },
): Promise<StagedContext> {
  const appdPath = appdBinaryPath();
  const caddyPath = appCaddyBinaryPath();
  await assertExists(appdPath, 'KORTIX_APPD_BIN_PATH');
  await assertExists(caddyPath, 'KORTIX_APP_CADDY_BIN_PATH');

  const contextDir = await mkdtemp(join(tmpdir(), 'kortix-app-snap-'));
  try {
    if (appContext.sourceDir) {
      const entries = await readdir(appContext.sourceDir);
      if (entries.includes('.kortix-app-runtime')) {
        throw new Error('App source contains reserved path .kortix-app-runtime');
      }
      for (const entry of entries) {
        await cp(join(appContext.sourceDir, entry), join(contextDir, entry), {
          recursive: true,
          preserveTimestamps: true,
        });
      }
    }

    const runtimeDir = join(contextDir, '.kortix-app-runtime');
    await mkdir(runtimeDir, { recursive: true });
    await copyFile(appdPath, join(runtimeDir, 'kortix-appd'));
    await copyFile(caddyPath, join(runtimeDir, 'caddy'));
    await chmod(join(runtimeDir, 'kortix-appd'), 0o755);
    await chmod(join(runtimeDir, 'caddy'), 0o755);
    await writeFileFs(
      join(runtimeDir, 'app.json'),
      `${JSON.stringify(appContext.runtimeSpec, null, 2)}\n`,
      { mode: 0o644 },
    );

    const dockerfileName = '.kortix-app.Dockerfile';
    const composedPath = join(contextDir, dockerfileName);
    const composed = `${userDockerfile.trimEnd()}\n\n` +
      `# Kortix Apps runtime ${snapshotName}\n` +
      'COPY .kortix-app-runtime/kortix-appd /kortix/bin/kortix-appd\n' +
      'COPY .kortix-app-runtime/caddy /kortix/bin/caddy\n' +
      'COPY .kortix-app-runtime/app.json /kortix/config/app.json\n' +
      'ENV KORTIX_APP_SPEC_PATH=/kortix/config/app.json\n' +
      'EXPOSE 7331 8080\n' +
      'ENTRYPOINT ["/kortix/bin/kortix-appd"]\n';
    await writeComposedDockerfile(composedPath, composed);
    console.info(`[apps] ${snapshotName}: App build context staged at ${contextDir}`);
    return { contextDir, composedPath, dockerfileName };
  } catch (error) {
    await rm(contextDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Materialize the managed `kortix-*` skills into a build-context directory —
 * the same extraction `packages/starter/scripts/write-managed-skills.ts` runs
 * for the standard sandbox image. The daemon overlays `/opt/kortix/managed-skills`
 * into the harness skills dir at boot (`ensureInjectedManagedSkills`), so this
 * is what teaches the meta coordinator the `kortix` CLI.
 */
async function stageManagedSkills(outDir: string): Promise<void> {
  // Same file set the API serves at GET /v1/runtime-assets/managed-skills, from
  // one definition — a sandbox that reconciles at runtime must land on the exact
  // bytes this bake would have produced, not a near-miss.
  for (const file of managedSkillOverlayFiles()) {
    const dest = join(outDir, file.path);
    await mkdir(dirname(dest), { recursive: true });
    await writeFileFs(dest, file.content);
  }
}

async function assertRuntimeArtifactsCurrent(
  agentPath: string,
  cliPath: string,
  attestationPath: string,
): Promise<void> {
  if (!process.env.KORTIX_SNAPSHOT_AGENT_BIN_PATH) {
    const srcDir = resolve(REPO_ROOT, 'apps/kortix-sandbox-agent-server/src');
    if (await agentBinaryStale(agentPath, srcDir)) {
      throw new Error(
        `kortix-agent dist binary (${agentPath}) is older than its source ` +
          `(${srcDir}) — run \`bun run build\` in apps/kortix-sandbox-agent-server ` +
          `or the image will bake stale code under a fresh content hash`,
      );
    }
  }
  await assertCliArtifactAttested({
    cliRoot: resolve(REPO_ROOT, 'apps/cli'),
    binaryPath: cliPath,
    attestationPath,
  });
}

export async function stageMetaBuildContext(): Promise<StagedContext> {
  const agentPath = agentBinPath();
  const cliPath = cliBinPath();
  const entrypointPath = entrypointSrcPath();
  await assertExists(agentPath, 'KORTIX_SNAPSHOT_AGENT_BIN_PATH');
  await assertExists(cliPath, 'KORTIX_SNAPSHOT_CLI_BIN_PATH');
  await assertExists(entrypointPath, 'KORTIX_SNAPSHOT_ENTRYPOINT_PATH');

  const contextDir = await mkdtemp(join(tmpdir(), 'kortix-meta-snap-'));
  await gzipFile(agentPath, join(contextDir, 'kortix-agent.gz'));
  await gzipFile(cliPath, join(contextDir, 'kortix.gz'));
  await copyFile(entrypointPath, join(contextDir, 'kortix-entrypoint'));
  await stageManagedSkills(join(contextDir, 'managed-skills'));
  await writeFileFs(
    join(contextDir, 'kortix-llm-catalog.json'),
    JSON.stringify({ models: gatewayModelCatalog('shared-seed') }),
  );

  const dockerfileName = 'Dockerfile';
  const composedPath = join(contextDir, dockerfileName);
  await writeFileFs(
    composedPath,
    buildMetaSandboxDockerfile({
      agentBinaryPath: 'kortix-agent.gz',
      cliBinaryPath: 'kortix.gz',
      entrypointScriptPath: 'kortix-entrypoint',
      catalogPath: 'kortix-llm-catalog.json',
      managedSkillsPath: 'managed-skills',
    }),
  );
  return { contextDir, composedPath, dockerfileName };
}

/** Stage the shared slim runtime selected by KORTIX_FAST_COLD_BOOT_ENABLED. */
export async function stageFastBuildContext(): Promise<StagedContext> {
  const agentPath = agentBinPath();
  const cliPath = cliBinPath();
  const entrypointPath = entrypointSrcPath();
  const opencodeWarmupPath = opencodeWarmupSrcPath();
  const slackPath = slackCliSrcPath();
  const machinePath = fastMachineDocSrcPath();
  const lazyToolsPath = lazyToolsSrcPath();
  const runtimeVersionsPath = runtimeVersionsSrcPath();
  const opencodeConfigPath = opencodeConfigSrcPath();

  await assertExists(agentPath, 'KORTIX_SNAPSHOT_AGENT_BIN_PATH');
  await assertExists(cliPath, 'KORTIX_SNAPSHOT_CLI_BIN_PATH');
  await assertExists(entrypointPath, 'KORTIX_SNAPSHOT_ENTRYPOINT_PATH');
  await assertExists(opencodeWarmupPath, 'KORTIX_SNAPSHOT_OPENCODE_WARMUP_PATH');
  await assertExists(machinePath, 'KORTIX_SNAPSHOT_FAST_MACHINE_DOC_PATH');
  await assertExists(runtimeVersionsPath, 'KORTIX_SNAPSHOT_RUNTIME_VERSIONS_PATH');
  await assertExistsDir(slackPath, 'KORTIX_SNAPSHOT_SLACK_CLI_PATH');
  await assertExistsDir(lazyToolsPath, 'KORTIX_SNAPSHOT_LAZY_TOOLS_PATH');
  await assertExistsDir(opencodeConfigPath, 'KORTIX_SNAPSHOT_OPENCODE_CONFIG_PATH');
  await assertRuntimeArtifactsCurrent(agentPath, cliPath, cliAttestationPath());

  const contextDir = await mkdtemp(join(tmpdir(), 'kortix-fast-snap-'));
  try {
    await gzipFile(agentPath, join(contextDir, 'kortix-agent.gz'));
    await gzipFile(cliPath, join(contextDir, 'kortix.gz'));
    await copyFile(entrypointPath, join(contextDir, 'kortix-entrypoint'));
    await copyFile(opencodeWarmupPath, join(contextDir, 'kortix-opencode-warmup'));
    await copyFile(machinePath, join(contextDir, 'MACHINE.fast.md'));
    await copyFile(runtimeVersionsPath, join(contextDir, 'runtime-versions.json'));
    await cp(slackPath, join(contextDir, 'kortix-slack-cli'), { recursive: true });
    await cp(lazyToolsPath, join(contextDir, 'lazy-tools'), { recursive: true });
    await stageOpencodeConfigTree(
      opencodeConfigPath,
      join(contextDir, 'kortix-opencode-config'),
    );
    await stageManagedSkills(join(contextDir, 'managed-skills'));
    await writeFileFs(
      join(contextDir, 'kortix-llm-catalog.json'),
      JSON.stringify({ models: gatewayModelCatalog('shared-seed') }),
    );
    await stageScaffoldRepo(contextDir);

    const dockerfileName = 'Dockerfile';
    const composedPath = join(contextDir, dockerfileName);
    const composed = buildFastSandboxDockerfile({
      agentBinaryPath: 'kortix-agent.gz',
      cliBinaryPath: 'kortix.gz',
      entrypointScriptPath: 'kortix-entrypoint',
      opencodeWarmupScriptPath: 'kortix-opencode-warmup',
      machineDocPath: 'MACHINE.fast.md',
      slackCliPath: 'kortix-slack-cli',
      lazyToolsPath: 'lazy-tools',
      catalogPath: 'kortix-llm-catalog.json',
      managedSkillsPath: 'managed-skills',
      runtimeVersionsPath: 'runtime-versions.json',
      opencodeConfigPath: 'kortix-opencode-config',
      scaffoldPath: 'scaffold.git',
    });
    await guardBuildahPortable(composed);
    await writeComposedDockerfile(composedPath, composed);
    for (const required of [
      dockerfileName,
      'kortix-agent.gz',
      'kortix.gz',
      'kortix-entrypoint',
      'kortix-opencode-warmup',
      'MACHINE.fast.md',
      'runtime-versions.json',
      'kortix-slack-cli',
      'lazy-tools/install',
      'kortix-opencode-config',
      'managed-skills',
      'kortix-llm-catalog.json',
      'scaffold.git',
    ]) {
      await stat(join(contextDir, required)).catch(() => {
        throw new Error(`fast build context staging incomplete: ${required} missing in ${contextDir}`);
      });
    }
    return { contextDir, composedPath, dockerfileName };
  } catch (error) {
    await rm(contextDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}


/**
 * The pi worker image: node + a boot script, nothing else. The actual harness
 * arrives at BOOT as the per-(project, sha) compiled artifact served by
 * GET /v1/git/{project}.git/compiled-pi-runtime — so this image is pure
 * transport and changes only when the scripts below change. The fingerprint
 * hashes exactly what is baked, mirroring the meta image's content-hash
 * discipline: same content ⇒ same snapshot, reused forever.
 */
export const PI_WORKER_ENTRYPOINT = '/usr/local/bin/pi-worker-entrypoint';

/**
 * The node flags every worker boot runs under — the "lock the file system on
 * the harness" item from the design huddle, enforced by node's permission
 * model rather than by care.
 *
 * Under `--permission` the process may READ only what is listed here — its own
 * artifact and `/proc/uptime` (the boot clock) — and nothing else: every other
 * fs read, every fs write, every child process and every worker thread is
 * `ERR_ACCESS_DENIED`. That holds for pi's built-in tools (which never touch
 * this disk anyway, see kortix-env.ts) AND for a user-authored tool bundled
 * into the artifact, which is the case the isolation test cannot cover: it
 * can only prove that the tools we ship stay off the disk, not that arbitrary
 * in-process code does. Network stays open — the worker is nothing but
 * network: the model gateway, the environment RPC, the durable store.
 *
 * Both boot paths — the cold entrypoint and park.mjs's post-claim spawn —
 * derive their argv from this ONE function, and pi-worker-lockdown.test.ts
 * drives the real compiled bundle through a tool turn under exactly these
 * flags, so a flag the bundle cannot live with fails there, not on a box.
 */
export function piWorkerNodeArgs(runtimeDir: string): string[] {
  return [
    '--permission',
    `--allow-fs-read=${runtimeDir}/session-worker.mjs`,
    '--allow-fs-read=/proc/uptime',
  ];
}

const PI_WORKER_ENTRYPOINT_SH = `#!/bin/sh
# Boot a session on the compiled pi worker runtime.
# Fails loudly: a worker that cannot fetch its exact artifact must not serve.
#
# Park mode (KORTIX_PI_PARK=1): the box was pre-created by the worker pool and
# knows no session yet. It idles on a tiny claim server; the API's pool claim
# delivers the session env (token, project, ref/sha) and the same fetch+exec
# path runs then. See PI_WORKER_PARK_MJS.
set -eu
export PORT="\${KORTIX_SERVICE_PORT:-8000}"
if [ -n "\${KORTIX_PI_PARK:-}" ]; then
  : "\${KORTIX_PI_PARK_TOKEN:?}"
  exec node /opt/kortix/park.mjs
fi
: "\${KORTIX_API_URL:?}" "\${KORTIX_TOKEN:?}" "\${KORTIX_PROJECT_ID:?}"
: "\${KORTIX_PI_RUNTIME_REF:?}" "\${KORTIX_PI_RUNTIME_SHA:?}"
node /opt/kortix/fetch-runtime.mjs
# Locked down (see piWorkerNodeArgs): reads limited to the artifact and the
# boot clock; no other reads, no writes, no child processes.
exec node ${piWorkerNodeArgs('/opt/kortix').join(' ')} /opt/kortix/session-worker.mjs
`;

const PI_WORKER_PARK_MJS = `// Parked pi worker box: idle until one session claims it.
// The claim is the ONLY serialization the pool has — first POST wins, every
// later one gets 409 — so racing API instances need no shared lock.
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';

const PORT = Number(process.env.PORT ?? 8000);
const PARK_TOKEN = process.env.KORTIX_PI_PARK_TOKEN ?? '';
// Resolved through realpath: the permission model compares the path node
// actually opens, so a symlinked runtime dir (macOS's /var -> /private/var in
// tests) would otherwise deny the worker its own entrypoint.
const RUNTIME_DIR = realpathSync(process.env.KORTIX_PI_PARK_DIR ?? '/opt/kortix');
// The claim, made durable.
//
// A claim arrives over HTTP and is spawned into a CHILD process, but the
// container's own environment still carries KORTIX_PI_PARK=1 — so the first
// stop/resume re-runs the entrypoint, which execs this script again with the
// claim env gone. The box then answered {parked:true,runtimeReady:false}
// forever and the session could never run another turn: its transcript
// survived, nothing else did. Writing the claim here, and preferring it over
// parking on every later boot, is what makes a resume come back as a worker.
//
// 0600: this file holds the session token, same as the process env already
// does. It never leaves the box.
const CLAIM_FILE = RUNTIME_DIR + '/claim.json';
const REQUIRED = [
  'KORTIX_API_URL',
  'KORTIX_TOKEN',
  'KORTIX_PROJECT_ID',
  'KORTIX_PI_RUNTIME_REF',
  'KORTIX_PI_RUNTIME_SHA',
];
let claimed = false;

function tokenOk(header) {
  const a = Buffer.from(String(header ?? ''));
  const b = Buffer.from(PARK_TOKEN);
  return PARK_TOKEN.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req, cap) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > cap) reject(new Error('claim body too large'));
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function boot(env) {
  // Same two steps the cold entrypoint runs, with the claim env layered over
  // the park env. Values never hit the log.
  const merged = { ...process.env, ...env };
  const fetchExit = await new Promise((resolve) => {
    const child = spawn('node', [RUNTIME_DIR + '/fetch-runtime.mjs'], { env: merged, stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
  if (fetchExit !== 0) {
    console.error(JSON.stringify({ msg: 'claimed park boot FAILED at fetch', exit: fetchExit }));
    process.exit(1);
  }
  // Same lockdown as the cold entrypoint (piWorkerNodeArgs in build-context.ts):
  // a claimed box must not be the one boot path that runs the harness unconfined.
  const worker = spawn(
    'node',
    [
      '--permission',
      '--allow-fs-read=' + RUNTIME_DIR + '/session-worker.mjs',
      '--allow-fs-read=/proc/uptime',
      RUNTIME_DIR + '/session-worker.mjs',
    ],
    { env: merged, stdio: 'inherit' },
  );
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => worker.kill(sig));
  worker.on('exit', (code) => process.exit(code ?? 1));
}

function validClaimEnv(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return false;
  for (const [key, value] of Object.entries(env)) {
    if (!/^KORTIX_[A-Z0-9_]*$/.test(key) || typeof value !== 'string') return false;
  }
  return REQUIRED.every((key) => Boolean(env[key]));
}

/** Atomic, so a crash mid-write cannot leave a half claim that parses. */
function persistClaim(env) {
  try {
    const tmp = CLAIM_FILE + '.tmp';
    writeFileSync(tmp, JSON.stringify(env), { mode: 0o600 });
    renameSync(tmp, CLAIM_FILE);
    return true;
  } catch (error) {
    console.error(JSON.stringify({ msg: 'claim persist FAILED', error: String(error?.message ?? error) }));
    return false;
  }
}

/** The claim from a previous life, or null. A corrupt file parks. */
function loadClaim() {
  try {
    const env = JSON.parse(readFileSync(CLAIM_FILE, 'utf8'));
    // Re-validated on the way in: a file that no longer satisfies the contract
    // must not boot a worker with a half env.
    return validClaimEnv(env) ? env : null;
  } catch {
    return null;
  }
}

const resumed = loadClaim();
if (resumed) {
  // Already claimed in a previous life. Never listen — the port belongs to the
  // worker, and a parked answer here is what stranded the session before.
  console.log(JSON.stringify({ msg: 'park resume: booting the claimed session', keys: Object.keys(resumed).length }));
  void boot(resumed);
} else {

const server = createServer(async (req, res) => {
  const path = String(req.url ?? '').split('?')[0];
  if (req.method === 'GET' && path === '/kortix/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, parked: true, runtimeReady: false }));
    return;
  }
  if (req.method === 'POST' && path === '/kortix/claim') {
    if (!tokenOk(req.headers['x-park-token'])) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad park token' }));
      return;
    }
    if (claimed) {
      res.writeHead(409, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'already claimed' }));
      return;
    }
    let env;
    try {
      const body = JSON.parse(await readBody(req, 256 * 1024));
      env = body?.env;
      if (!env || typeof env !== 'object' || Array.isArray(env)) throw new Error('env map required');
      for (const [key, value] of Object.entries(env)) {
        if (!/^KORTIX_[A-Z0-9_]*$/.test(key) || typeof value !== 'string') {
          throw new Error('claim env keys must be KORTIX_* strings');
        }
      }
      for (const key of REQUIRED) {
        if (!env[key]) throw new Error('claim env missing ' + key);
      }
    } catch (error) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(error?.message ?? error) }));
      return;
    }
    claimed = true;
    // Persist BEFORE answering: a claim the API believes succeeded must
    // survive a restart, so the durable write is part of accepting it.
    if (!persistClaim(env)) {
      claimed = false;
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'could not persist claim' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    console.log(JSON.stringify({ msg: 'park claim accepted', keys: Object.keys(env).length }));
    // Free the port for the worker, then boot with the claim env.
    server.close(() => void boot(env));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});
server.listen(PORT, () => {
  console.log(JSON.stringify({ msg: 'pi worker parked', port: PORT }));
});

}
`;

const PI_WORKER_FETCH_MJS = `// Download this session's compiled pi runtime, verified before it may run.
import { createHash } from 'node:crypto';
import { writeFileSync, renameSync } from 'node:fs';

const url = new URL(
  \`\${process.env.KORTIX_API_URL.replace(/\\/$/, '')}/git/\${process.env.KORTIX_PROJECT_ID}.git/compiled-pi-runtime\`,
);
url.searchParams.set('ref', process.env.KORTIX_PI_RUNTIME_REF);
url.searchParams.set('sha', process.env.KORTIX_PI_RUNTIME_SHA);

let lastError = 'unknown';
for (let attempt = 1; attempt <= 30; attempt++) {
  try {
    const res = await fetch(url, {
      headers: { authorization: \`Bearer \${process.env.KORTIX_TOKEN}\` },
    });
    if (!res.ok) throw new Error(\`HTTP \${res.status}\`);
    const body = Buffer.from(await res.arrayBuffer());
    const expected = res.headers.get('x-kortix-artifact-sha256');
    const actual = createHash('sha256').update(body).digest('hex');
    // Digest-verified like every other converged runtime asset: a truncated or
    // tampered artifact never reaches exec.
    if (expected && expected !== actual) throw new Error('artifact sha256 mismatch');
    const text = body.toString('utf8');
    if (!text.includes('kortix-worker starting')) throw new Error('artifact has no worker entrypoint');
    writeFileSync('/opt/kortix/session-worker.mjs.tmp', body, { mode: 0o500 });
    renameSync('/opt/kortix/session-worker.mjs.tmp', '/opt/kortix/session-worker.mjs');
    console.log(JSON.stringify({ msg: 'pi runtime fetched', bytes: body.length, sha256: actual }));
    process.exit(0);
  } catch (error) {
    lastError = String(error?.message ?? error);
    console.error(JSON.stringify({ msg: 'pi runtime fetch retry', attempt, error: lastError }));
    await new Promise((r) => setTimeout(r, Math.min(500 * attempt, 5000)));
  }
}
console.error(JSON.stringify({ msg: 'pi runtime fetch FAILED', error: lastError }));
process.exit(1);
`;

function buildPiWorkerDockerfile(): string {
  // alpine, not slim: the worker is pure JS (`@earendil-works/pi-*` + `ws`,
  // no native modules, no child_process), so musl costs nothing and the base
  // is ~40 MB smaller. `adduser` is busybox's, not shadow's — the Debian
  // `useradd` flags do not exist here.
  return `FROM node:22-alpine
RUN adduser -D -s /sbin/nologin kortix \\
    && mkdir -p /opt/kortix && chown kortix:kortix /opt/kortix
COPY pi-worker-entrypoint /usr/local/bin/pi-worker-entrypoint
COPY fetch-runtime.mjs /opt/kortix/fetch-runtime.mjs
COPY park.mjs /opt/kortix/park.mjs
RUN chmod 0555 /usr/local/bin/pi-worker-entrypoint /opt/kortix/fetch-runtime.mjs /opt/kortix/park.mjs
USER kortix
ENV NODE_ENV=production
`;
}

/** Content identity of the pi worker image — nothing else goes into it. */
export function piWorkerImageFingerprint(): string {
  return createHash('sha256')
    .update(
      `pi-worker-v2\0${buildPiWorkerDockerfile()}\0${PI_WORKER_ENTRYPOINT_SH}\0${PI_WORKER_FETCH_MJS}\0${PI_WORKER_PARK_MJS}`,
    )
    .digest('hex');
}

/** The park server script, exported for the handshake test only. */
export function piWorkerParkScriptForTest(): string {
  return PI_WORKER_PARK_MJS;
}

export async function stagePiWorkerBuildContext(): Promise<StagedContext> {
  const contextDir = await mkdtemp(join(tmpdir(), 'kortix-piworker-snap-'));
  await writeFileFs(join(contextDir, 'pi-worker-entrypoint'), PI_WORKER_ENTRYPOINT_SH, { mode: 0o755 });
  await writeFileFs(join(contextDir, 'fetch-runtime.mjs'), PI_WORKER_FETCH_MJS);
  await writeFileFs(join(contextDir, 'park.mjs'), PI_WORKER_PARK_MJS);
  const dockerfileName = 'Dockerfile';
  const composedPath = join(contextDir, dockerfileName);
  await writeFileFs(composedPath, buildPiWorkerDockerfile());
  return { contextDir, composedPath, dockerfileName };
}

export type RuntimeBuildProfile = 'standard' | 'fast' | 'meta' | 'app' | 'pi-worker';

/** Select one runtime renderer for every provider adapter. */
export async function stageRuntimeBuildContext(input: {
  snapshotName: string;
  userDockerfile: string;
  runtimeProfile?: RuntimeBuildProfile;
  appContext?: { sourceDir?: string; runtimeSpec: Record<string, unknown> };
  isShared?: boolean;
}): Promise<StagedContext> {
  switch (input.runtimeProfile) {
    case 'app':
      if (!input.appContext) throw new Error('app runtime profile requires appContext');
      return stageAppBuildContext(input.snapshotName, input.userDockerfile, input.appContext);
    case 'meta':
      return stageMetaBuildContext();
    case 'pi-worker':
      return stagePiWorkerBuildContext();
    case 'fast':
      return stageFastBuildContext();
    default:
      return stageBuildContext(
        input.snapshotName,
        input.userDockerfile,
        input.isShared,
      );
  }
}


/**
 * Stage a build context for `snapshotName` from the user's Dockerfile. Returns
 * the temp dir + composed Dockerfile path. The CALLER is responsible for
 * removing contextDir when done.
 *
 * `isSharedDefault` is the caller's `BuildableTemplate.isShared` — it tells the
 * layer whether /workspace is the platform's to wipe after the opencode warm-up
 * or the user's to leave alone (see `KortixToolchainLayerOpts.isSharedDefault`).
 */
export async function stageBuildContext(
  snapshotName: string,
  userDockerfile: string,
  isSharedDefault?: boolean,
): Promise<StagedContext> {
  const AGENT_BIN_PATH = agentBinPath();
  const CLI_BIN_PATH = cliBinPath();
  const CLI_ATTESTATION_PATH = cliAttestationPath();
  const ENTRYPOINT_PATH = entrypointSrcPath();
  const SLACK_CLI_SRC_PATH = slackCliSrcPath();
  const OPENCODE_CONFIG_SRC_PATH = opencodeConfigSrcPath();
  const OPENCODE_WARMUP_SRC_PATH = opencodeWarmupSrcPath();
  const MACHINE_DOC_SRC_PATH = machineDocSrcPath();
  await assertExists(AGENT_BIN_PATH, 'KORTIX_SNAPSHOT_AGENT_BIN_PATH');
  await assertExists(CLI_BIN_PATH, 'KORTIX_SNAPSHOT_CLI_BIN_PATH');
  await assertExists(ENTRYPOINT_PATH, 'KORTIX_SNAPSHOT_ENTRYPOINT_PATH');
  await assertExistsDir(SLACK_CLI_SRC_PATH, 'KORTIX_SNAPSHOT_SLACK_CLI_PATH');
  await assertExists(OPENCODE_WARMUP_SRC_PATH, 'KORTIX_SNAPSHOT_OPENCODE_WARMUP_PATH');
  await assertExists(MACHINE_DOC_SRC_PATH, 'KORTIX_SNAPSHOT_MACHINE_DOC_PATH');
  // Fingerprint/artifact skew guard: the snapshot identity hashes the agent
  // SOURCE (templates.ts AGENT_SRC_DIR), but the image bakes this prebuilt
  // dist binary — an edited src/ with a stale dist/ ships old code under a
  // NEW content hash, which is worse than failing (caught live 2026-06-10: a
  // daemon fix "rebuilt" into a fresh template whose forks still ran the old
  // binary). Refuse to stage a context whose binary predates the source.
  // Env-overridden binary paths skip this — the caller is pinning on purpose.
  if (!process.env.KORTIX_SNAPSHOT_AGENT_BIN_PATH) {
    const srcDir = resolve(REPO_ROOT, 'apps/kortix-sandbox-agent-server/src');
    if (await agentBinaryStale(AGENT_BIN_PATH, srcDir)) {
      throw new Error(
        `kortix-agent dist binary (${AGENT_BIN_PATH}) is older than its source ` +
        `(${srcDir}) — run \`bun run build\` in apps/kortix-sandbox-agent-server ` +
        `or the image will bake stale code under a fresh content hash`,
      );
    }
  }
  // The snapshot identity hashes CLI SOURCE, but the image bakes this compiled
  // binary. Refuse source/binary skew before the provider sees a context. A
  // local API with edited CLI source and stale dist previously poisoned the
  // shared content-addressed image under the NEW source hash.
  await assertCliArtifactAttested({
    cliRoot: resolve(REPO_ROOT, 'apps/cli'),
    binaryPath: CLI_BIN_PATH,
    attestationPath: CLI_ATTESTATION_PATH,
  });

  const contextDir = await mkdtemp(join(tmpdir(), 'kortix-snap-'));
  return removeStagedContextOnFailure(contextDir, async () => {
    await gzipFile(AGENT_BIN_PATH, join(contextDir, 'kortix-agent.gz'));
    await gzipFile(CLI_BIN_PATH, join(contextDir, 'kortix.gz'));
    await copyFile(ENTRYPOINT_PATH, join(contextDir, 'kortix-entrypoint'));
    await copyFile(OPENCODE_WARMUP_SRC_PATH, join(contextDir, 'kortix-opencode-warmup'));
    await copyFile(MACHINE_DOC_SRC_PATH, join(contextDir, 'MACHINE.md'));
    await cp(SLACK_CLI_SRC_PATH, join(contextDir, 'kortix-slack-cli'), { recursive: true });
    // Stage the starter opencode config for the build-time instance warm-up.
    // Best effort: if it's missing, skip the warm-up (the build still succeeds and
    // sessions just pay the first-instance cost at runtime as before).
    let opencodeConfigPath: string | undefined;
    if (await isDir(OPENCODE_CONFIG_SRC_PATH)) {
      await cp(OPENCODE_CONFIG_SRC_PATH, join(contextDir, 'kortix-opencode-config'), {
        recursive: true,
      });
      opencodeConfigPath = 'kortix-opencode-config';
    }

    // Bake the FULL gateway model catalog into the image. The no-restart warm seed
    // has no sandbox token / projectId to fetch the catalog at PARK, so without this
    // its opencode picker would fall back to the daemon's minimal (~11) set. Computed
    // server-side at build time → full picker, no token, no runtime fetch. The shared
    // seed's captureEnv (builder.ts) points KORTIX_LLM_CATALOG_FILE at the COPY target.
    await writeFileFs(
      join(contextDir, 'kortix-llm-catalog.json'),
      JSON.stringify({ models: gatewayModelCatalog('shared-seed') }),
    );

    // Canonical scaffold repo baked at /opt/kortix/scaffold.git. Built from the
    // DEFAULT starter with the SAME pinned commit metadata the project seeder
    // uses (git-backends/seed.ts), so its root SHA equals every seeded project's
    // root — the daemon then materializes a project repo as local-clone +
    // delta-fetch instead of a full clone over the (slow) git path. Non-matching
    // repos (imported, other starters) share no ancestor and transparently fall
    // back to a full fetch through the same code.
    await stageScaffoldRepo(contextDir);

    const dockerfileName = '.kortix-snapshot.Dockerfile';
    const composedPath = join(contextDir, dockerfileName);
    const composed = buildLayeredDockerfile({
      userDockerfile,
      opencodeVersion: OPENCODE_VERSION,
      agentBrowserVersion: AGENT_BROWSER_VERSION,
      agentBinaryPath: 'kortix-agent.gz',
      cliBinaryPath: 'kortix.gz',
      entrypointScriptPath: 'kortix-entrypoint',
      machineDocPath: 'MACHINE.md',
      slackCliPath: 'kortix-slack-cli',
      opencodeConfigPath,
      opencodeWarmupScriptPath: 'kortix-opencode-warmup',
      catalogPath: 'kortix-llm-catalog.json',
      isSharedDefault,
    });

    await guardBuildahPortable(composed);
    await writeComposedDockerfile(composedPath, composed);
    // Fail-loud completeness guard: a context missing scaffold.git / the agent
    // binary / the composed Dockerfile reaches the provider as a confusing remote
    // "Path does not exist", and the auto-build can't tell it's a staging miss to
    // recover from. Assert at the source so a miss is caught here AND is retryable
    // (the daytona adapter re-stages on "staging incomplete").
    console.info(`[snapshots] ${snapshotName}: build context staged at ${contextDir}`);
    return { contextDir, composedPath, dockerfileName };
  });
}


// ── Buildah-portability guard ──────────────────────────────────────────────
// The SAME composed context ships to BOTH providers. Daytona builds with
// BuildKit (supports `# syntax=docker/dockerfile:1.7` + RUN heredocs); Platinum
// builds with podman/buildah's classic imagebuilder, which supports NEITHER — it
// parses a heredoc body's first line (e.g. `import importlib`) as a Dockerfile
// instruction and aborts EVERY build ("Unknown instruction: IMPORT"), failing
// all Platinum sessions. This exact regression (a `<<'PY'` python verify added
// 2026-06-27) took dev down for hours because Daytona silently tolerated it.
// Reject it at the SOURCE with a clear error instead of an opaque remote build
// failure minutes later — and keep the Dockerfile portable to both builders.
async function guardBuildahPortable(composed: string): Promise<void> {
  const heredocLine = composed
    .split('\n')
    .find((l) => !/^\s*#/.test(l) && /<<-?['"]?[A-Za-z_]\w*['"]?\s*\\?\s*$/.test(l));
  if (heredocLine) {
    throw new Error(
      `composed Dockerfile is not buildah-portable — it contains a RUN heredoc Platinum's ` +
        `builder cannot parse: "${heredocLine.trim().slice(0, 120)}". Use a single-line ` +
        `equivalent (e.g. \`python3 -c '...'\`). Heredocs and BuildKit-only \`# syntax\` ` +
        `directives work on Daytona but silently break every Platinum template build.`,
    );
  }
}

async function writeComposedDockerfile(composedPath: string, composed: string): Promise<void> {
  if (typeof (globalThis as any).Bun?.write === 'function') {
    await (globalThis as any).Bun.write(composedPath, composed);
  } else {
    const fs = await import('node:fs/promises');
    await fs.writeFile(composedPath, composed);
  }
}

/**
 * Verify the staged context contains the load-bearing files the composed
 * Dockerfile COPYs, so a staging miss fails HERE (clear + retryable) instead of
 * as an opaque provider "Path does not exist" mid-build. Cheap stat checks.
 */
async function assertContextComplete(
  contextDir: string,
  dockerfileName: string,
): Promise<void> {
  const required = [
    'scaffold.git',
    'kortix-agent.gz',
    'kortix-opencode-warmup',
    'MACHINE.md',
    // The baked model catalog is what keeps `opencode serve` off the network at
    // boot: the daemon reads /opt/kortix/llm-catalog.json instead of fetching
    // the gateway's ~400KB /models. If it silently fails to stage, the image
    // still builds and every session on it pays a synchronous cross-region
    // fetch that gates opencode's port bind. That is invisible in build logs and
    // shows up only as "boot got slower", so assert it here.
    'kortix-llm-catalog.json',
    dockerfileName,
  ];
  for (const rel of required) {
    try {
      await stat(join(contextDir, rel));
    } catch {
      throw new Error(`build context staging incomplete: ${rel} missing in ${contextDir}`);
    }
  }
}

async function newestMtimeMs(dir: string): Promise<number> {
  const { readdir } = await import('node:fs/promises');
  let newest = 0;
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const s = await stat(join(entry.parentPath ?? (entry as any).path ?? dir, entry.name)).catch(() => null);
    if (s && s.mtimeMs > newest) newest = s.mtimeMs;
  }
  return newest;
}

/**
 * SHA-256 of the daemon SOURCE tree — every file's relative path + bytes, in a
 * stable (sorted) order. Deterministic and mtime-INDEPENDENT: a `git checkout`
 * that rewrites file mtimes without changing content produces the same hash.
 */
async function srcContentHash(dir: string): Promise<string> {
  const { readdir } = await import('node:fs/promises');
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    files.push(join((entry.parentPath ?? (entry as { path?: string }).path) ?? dir, entry.name));
  }
  files.sort();
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file.slice(dir.length));
    hash.update('\0');
    hash.update(await readFile(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/**
 * Is the compiled daemon binary stale relative to its source?
 *
 * mtime is the fast path: a binary newer than every source file is trivially
 * current. The mtime-stale branch is the one that used to false-positive — a
 * `git checkout` / branch switch bumps every source file's mtime past the
 * gitignored binary WITHOUT changing content, which in a worktree workflow
 * fired "runtime artifact missing" on a binary that was perfectly current.
 *
 * So the stale branch now confirms with a CONTENT hash. The build records the
 * source hash next to the binary (`<binary>.srchash`, removed on every rebuild
 * so it re-memoizes); the guard also writes it opportunistically the first time
 * it sees an mtime-current binary. A stored hash that matches the live source
 * proves the binary is current despite the mtime, so the guard does not
 * false-positive. Only a genuine content change with no rebuild — a missing or
 * mismatched hash on the stale branch — reads as stale.
 */
async function agentBinaryStale(agentPath: string, srcDir: string): Promise<boolean> {
  const binMtime = (await stat(agentPath)).mtimeMs;
  const newestSrc = await newestMtimeMs(srcDir);
  const hashPath = `${agentPath}.srchash`;
  if (newestSrc <= binMtime) {
    // Current by mtime. Memoize the source hash once (only when absent, so the
    // steady state pays nothing) so a later checkout can be recognized as a
    // no-op instead of false-positive stale.
    if (!(await stat(hashPath).catch(() => null))) {
      await writeFileFs(hashPath, await srcContentHash(srcDir)).catch(() => {});
    }
    return false;
  }
  const stored = await readFile(hashPath, 'utf8')
    .then((s) => s.trim())
    .catch(() => null);
  if (!stored) return true; // no attestation on the stale branch → trust mtime
  return stored !== (await srcContentHash(srcDir));
}

async function assertExists(path: string, envVarHint: string): Promise<void> {
  if (!isAbsolute(path)) {
    throw new Error(`${envVarHint} must be an absolute path (got "${path}")`);
  }
  try {
    const s = await stat(path);
    if (!s.isFile()) throw new Error(`${envVarHint} (${path}) is not a regular file`);
  } catch (err) {
    if (err instanceof Error && err.message.includes(envVarHint)) throw err;
    throw new Error(
      `Required artifact missing: ${path}. Set ${envVarHint} or run \`bun run build\` in apps/kortix-sandbox-agent-server.`,
    );
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function assertExistsDir(path: string, envVarHint: string): Promise<void> {
  if (!isAbsolute(path)) {
    throw new Error(`${envVarHint} must be an absolute path (got "${path}")`);
  }
  try {
    const s = await stat(path);
    if (!s.isDirectory()) throw new Error(`${envVarHint} (${path}) is not a directory`);
  } catch (err) {
    if (err instanceof Error && err.message.includes(envVarHint)) throw err;
    throw new Error(
      `Required directory missing: ${path}. Set ${envVarHint} or ship apps/sandbox/slack-cli.`,
    );
  }
}

async function gzipFile(sourcePath: string, targetPath: string): Promise<void> {
  await pipeline(
    createReadStream(sourcePath),
    createGzip({ level: 9 }),
    createWriteStream(targetPath),
  );
}

/**
 * Gzip ONLY the kortix-agent binary to a temp .gz — for the Platinum agent-swap
 * fast path, which ships just the agent (not a whole build context) and has the
 * host debugfs-swap it into the predecessor's rootfs. Caller cleans up.
 */
export async function stageAgentBinaryGz(): Promise<{ gzPath: string; cleanup: () => Promise<void> }> {
  const AGENT_BIN_PATH = agentBinPath();
  await assertExists(AGENT_BIN_PATH, 'KORTIX_SNAPSHOT_AGENT_BIN_PATH');
  // Refuse an empty/truncated dist (e.g. an interrupted `bun build`) at the source.
  // The host re-validates (ELF/size + post-swap size match), but failing here keeps
  // a dead agent from ever being uploaded + swapped into a template.
  if ((await stat(AGENT_BIN_PATH)).size === 0) {
    throw new Error(`agent binary ${AGENT_BIN_PATH} is empty — refusing to stage for agent-swap`);
  }
  const dir = await mkdtemp(join(tmpdir(), 'kortix-agent-swap-'));
  const gzPath = join(dir, 'kortix-agent.gz');
  await gzipFile(AGENT_BIN_PATH, gzPath);
  return { gzPath, cleanup: async () => { await rm(dir, { recursive: true, force: true }).catch(() => {}); } };
}

async function stageScaffoldRepo(contextDir: string): Promise<void> {
  const work = join(contextDir, '.scaffold-work');
  await mkdir(work, { recursive: true });
  const files = buildStarterFiles({ projectName: 'kortix-project', repoFullName: 'kortix/kortix-project', template: DEFAULT_STARTER_TEMPLATE_ID });
  for (const f of files) {
    const full = join(work, f.path);
    await mkdir(dirname(full), { recursive: true });
    await writeFileFs(full, f.content, 'utf8');
  }
  const env = {
    ...process.env, GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Kortix', GIT_AUTHOR_EMAIL: 'noreply@kortix.ai',
    GIT_COMMITTER_NAME: 'Kortix', GIT_COMMITTER_EMAIL: 'noreply@kortix.ai',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  };
  const g = (args: string[], cwd: string) => execFileAsyncBC('git', args, { cwd, env, timeout: 60_000 });
  await g(['init', '-b', 'main'], work);
  await g(['config', 'user.name', 'Kortix'], work);
  await g(['config', 'user.email', 'noreply@kortix.ai'], work);
  await g(['add', '-A'], work);
  await g(['commit', '-m', 'chore: scaffold Kortix project'], work);
  const scaffoldGit = join(contextDir, 'scaffold.git');
  await rename(join(work, '.git'), scaffoldGit);
  await g(['--git-dir', scaffoldGit, 'config', 'core.bare', 'true'], contextDir);
  await rm(work, { recursive: true, force: true });
}

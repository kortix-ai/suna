/**
 * Shared build-context staging for sandbox snapshots.
 *
 * Both providers build the SAME image: the user's Dockerfile + the Kortix
 * runtime layer (agent binary + CLI + entrypoint + slack-cli +
 * agent-browser). Daytona ships this context to its build service via
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
  open as openFile,
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
import { AGENT_BROWSER_VERSION } from '@kortix/shared';
import { buildMyKortixSandboxDockerfile } from '@kortix/shared/sandbox';
import { managedSkillOverlayFiles } from '../runtime-assets/managed-skills';
import { appCaddyBinaryPath, appdBinaryPath } from '../apps/runtime-artifacts';
import { buildStarterFiles, DEFAULT_STARTER_TEMPLATE_ID } from '../projects/starter';
import { assertCliArtifactAttested } from './cli-artifact-attestation';
import { buildLayeredDockerfile } from './dockerfile-layer';

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
const machineDocSrcPath = () => process.env.KORTIX_SNAPSHOT_MACHINE_DOC_PATH
  || resolve(REPO_ROOT, 'apps/sandbox/MACHINE.md');

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/** Default resource spec, shared by every provider and the template synthesis when a template omits one. */
export const DEFAULT_CPU = readPositiveIntEnv('KORTIX_DEFAULT_SANDBOX_CPU', 2);
export const DEFAULT_MEMORY_GB = readPositiveIntEnv('KORTIX_DEFAULT_SANDBOX_MEMORY_GB', 4);
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
          // Keep link targets as written. Without this, cp rewrites a
          // relative target to an absolute path on this host.
          verbatimSymlinks: true,
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


/**
 * Build-context names of the Kortix defaults' staged artifacts
 * (`kortixDefaultsTail` in @kortix/shared/sandbox defaults.ts). Every image
 * stages them through `stageDefaultArtifacts`, so a project agent's image and
 * My Kortix's carry the same bytes.
 */
const DEFAULT_ARTIFACTS = {
  agentBinaryPath: 'kortix-agent.gz',
  cliBinaryPath: 'kortix.gz',
  entrypointScriptPath: 'kortix-entrypoint',
  machineDocPath: 'MACHINE.md',
  slackCliPath: 'kortix-slack-cli',
  managedSkillsPath: 'managed-skills',
} as const;

/** Refuse to stage the defaults from missing or stale build outputs. */
async function assertDefaultArtifactsReady(): Promise<void> {
  const AGENT_BIN_PATH = agentBinPath();
  const CLI_BIN_PATH = cliBinPath();
  await assertExists(AGENT_BIN_PATH, 'KORTIX_SNAPSHOT_AGENT_BIN_PATH');
  await assertExists(CLI_BIN_PATH, 'KORTIX_SNAPSHOT_CLI_BIN_PATH');
  await assertExists(entrypointSrcPath(), 'KORTIX_SNAPSHOT_ENTRYPOINT_PATH');
  await assertExistsDir(slackCliSrcPath(), 'KORTIX_SNAPSHOT_SLACK_CLI_PATH');
  await assertExists(machineDocSrcPath(), 'KORTIX_SNAPSHOT_MACHINE_DOC_PATH');
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
    attestationPath: cliAttestationPath(),
  });
}

/** Copy the defaults' artifacts into `contextDir` under `DEFAULT_ARTIFACTS` names. */
async function stageDefaultArtifacts(contextDir: string): Promise<void> {
  await gzipFile(agentBinPath(), join(contextDir, DEFAULT_ARTIFACTS.agentBinaryPath));
  await gzipFile(cliBinPath(), join(contextDir, DEFAULT_ARTIFACTS.cliBinaryPath));
  await copyFile(entrypointSrcPath(), join(contextDir, DEFAULT_ARTIFACTS.entrypointScriptPath));
  await copyFile(machineDocSrcPath(), join(contextDir, DEFAULT_ARTIFACTS.machineDocPath));
  await cp(slackCliSrcPath(), join(contextDir, DEFAULT_ARTIFACTS.slackCliPath), { recursive: true });
  // Canonical scaffold repo baked at /opt/kortix/scaffold.git. Built from the
  // DEFAULT starter with the SAME pinned commit metadata the project seeder
  // uses (git-backends/seed.ts), so its root SHA equals every seeded project's
  // root — the daemon then materializes a project repo as local-clone +
  // delta-fetch instead of a full clone over the (slow) git path. Non-matching
  // repos (imported, other starters) share no ancestor and transparently fall
  // back to a full fetch through the same code.
  await stageScaffoldRepo(contextDir);
  // The managed `kortix-*` skill overlay. Without it a box downloads the whole
  // overlay on its first reconcile. `kortix-starter` is a snapshot-fingerprint
  // input, so a skill edit mints a new snapshot and the bake stays current.
  await stageManagedSkills(join(contextDir, DEFAULT_ARTIFACTS.managedSkillsPath));
}

/** My Kortix's image: the Kortix defaults and its guide (my-kortix-dockerfile.ts). */
export async function stageMyKortixBuildContext(): Promise<StagedContext> {
  await assertDefaultArtifactsReady();
  const contextDir = await mkdtemp(join(tmpdir(), 'kortix-meta-snap-'));
  return removeStagedContextOnFailure(contextDir, async () => {
    await stageDefaultArtifacts(contextDir);
    const dockerfileName = 'Dockerfile';
    const composedPath = join(contextDir, dockerfileName);
    await writeComposedDockerfile(composedPath, buildMyKortixSandboxDockerfile(DEFAULT_ARTIFACTS));
    await assertContextComplete(contextDir, dockerfileName);
    return { contextDir, composedPath, dockerfileName };
  });
}

export type RuntimeBuildProfile = 'standard' | 'mykortix' | 'app';

/** Select one runtime renderer for every provider adapter. */
export async function stageRuntimeBuildContext(input: {
  snapshotName: string;
  userDockerfile: string;
  runtimeProfile?: RuntimeBuildProfile;
  appContext?: { sourceDir?: string; runtimeSpec: Record<string, unknown> };
  containerRuntime?: boolean;
}): Promise<StagedContext> {
  switch (input.runtimeProfile) {
    case 'app':
      if (!input.appContext) throw new Error('app runtime profile requires appContext');
      return stageAppBuildContext(input.snapshotName, input.userDockerfile, input.appContext);
    case 'mykortix':
      return stageMyKortixBuildContext();
    default:
      return stageBuildContext(input.snapshotName, input.userDockerfile, input.containerRuntime);
  }
}


/**
 * Stage a build context for `snapshotName` from the user's Dockerfile. Returns
 * the temp dir + composed Dockerfile path. The CALLER is responsible for
 * removing contextDir when done.
 */
export async function stageBuildContext(
  snapshotName: string,
  userDockerfile: string,
  containerRuntime?: boolean,
): Promise<StagedContext> {
  await assertDefaultArtifactsReady();
  const contextDir = await mkdtemp(join(tmpdir(), 'kortix-snap-'));
  return removeStagedContextOnFailure(contextDir, async () => {
    await stageDefaultArtifacts(contextDir);
    const dockerfileName = '.kortix-snapshot.Dockerfile';
    const composedPath = join(contextDir, dockerfileName);
    const composed = buildLayeredDockerfile({
      userDockerfile,
      agentBrowserVersion: AGENT_BROWSER_VERSION,
      ...DEFAULT_ARTIFACTS,
      containerRuntime,
    });

    await guardBuildahPortable(composed);
    await writeComposedDockerfile(composedPath, composed);
    // Fail-loud completeness guard: a context missing scaffold.git / the agent
    // binary / the composed Dockerfile reaches the provider as a confusing remote
    // "Path does not exist", and the auto-build can't tell it's a staging miss to
    // recover from. Assert at the source so a miss is caught here AND is retryable
    // (the daytona adapter re-stages on "staging incomplete").
    await assertContextComplete(contextDir, dockerfileName);
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
    'MACHINE.md',
    // The managed skill overlay. A miss here is the defect this guard exists
    // for: the image still builds, and every box on it silently downloads the
    // overlay on its first reconcile instead of booting with it.
    'managed-skills',
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
    // `wx` creates the file ONLY if it is absent, and does so atomically. The
    // previous shape — stat, then write when the stat said "missing" — is a
    // check-then-act race (CodeQL js/file-system-race): two concurrent builds
    // both see it absent and both write. Opening exclusively also keeps the
    // steady-state cost at zero, because the hash is computed only on the
    // branch that actually won the create.
    const handle = await openFile(hashPath, 'wx').catch(() => null);
    if (handle) {
      try {
        await handle.writeFile(await srcContentHash(srcDir));
      } catch {
        // A memoized hash is an optimization; losing it only costs a rebuild.
      } finally {
        await handle.close().catch(() => {});
      }
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

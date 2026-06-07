/**
 * Shared build-context staging for sandbox snapshots.
 *
 * Both providers build the SAME image: the user's Dockerfile + the Kortix
 * runtime layer (agent binary + CLI + entrypoint + agent-cli + executor-sdk +
 * opencode/agent-browser). Daytona ships this context to its build service via
 * `Image.fromDockerfile(ctx)`; Platinum ships it to `POST /v1/templates/
 * from-build`. Staging the context here — once — guarantees the produced image
 * is byte-identical across providers and keeps the artifact paths in one place.
 *
 * Extracted verbatim from the Daytona adapter (no behaviour change); see
 * snapshots/providers/daytona.ts (Daytona) + snapshots/providers/platinum.ts.
 */

import { copyFile, cp, mkdtemp, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { tmpdir } from 'node:os';
import { buildLayeredDockerfile } from './dockerfile-layer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../..');
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

const OPENCODE_VERSION = '1.15.10';
const AGENT_BROWSER_VERSION = '0.27.0';

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/** Default resource spec, shared by every provider when a template omits one. */
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

/**
 * Stage a build context for `snapshotName` from the user's Dockerfile. Returns
 * the temp dir + composed Dockerfile path. The CALLER is responsible for
 * removing contextDir when done.
 */
export async function stageBuildContext(
  snapshotName: string,
  userDockerfile: string,
): Promise<StagedContext> {
  await assertExists(AGENT_BIN_PATH, 'KORTIX_SNAPSHOT_AGENT_BIN_PATH');
  await assertExists(CLI_BIN_PATH, 'KORTIX_SNAPSHOT_CLI_BIN_PATH');
  await assertExists(ENTRYPOINT_PATH, 'KORTIX_SNAPSHOT_ENTRYPOINT_PATH');
  await assertExistsDir(AGENT_CLI_SRC_PATH, 'KORTIX_SNAPSHOT_AGENT_CLI_PATH');
  await assertExistsDir(EXECUTOR_SDK_SRC_PATH, 'KORTIX_SNAPSHOT_EXECUTOR_SDK_PATH');

  const contextDir = await mkdtemp(join(tmpdir(), 'kortix-snap-'));
  await gzipFile(AGENT_BIN_PATH, join(contextDir, 'kortix-agent.gz'));
  await gzipFile(CLI_BIN_PATH, join(contextDir, 'kortix.gz'));
  await copyFile(ENTRYPOINT_PATH, join(contextDir, 'kortix-entrypoint'));
  await cp(AGENT_CLI_SRC_PATH, join(contextDir, 'kortix-agent-cli'), { recursive: true });
  await cp(EXECUTOR_SDK_SRC_PATH, join(contextDir, 'kortix-executor-sdk'), { recursive: true });

  const dockerfileName = '.kortix-snapshot.Dockerfile';
  const composedPath = join(contextDir, dockerfileName);
  const composed = buildLayeredDockerfile({
    userDockerfile,
    opencodeVersion: OPENCODE_VERSION,
    agentBrowserVersion: AGENT_BROWSER_VERSION,
    agentBinaryPath: 'kortix-agent.gz',
    cliBinaryPath: 'kortix.gz',
    entrypointScriptPath: 'kortix-entrypoint',
    agentCliPath: 'kortix-agent-cli',
    executorSdkPath: 'kortix-executor-sdk',
  });
  if (typeof (globalThis as any).Bun?.write === 'function') {
    await (globalThis as any).Bun.write(composedPath, composed);
  } else {
    const fs = await import('node:fs/promises');
    await fs.writeFile(composedPath, composed);
  }
  console.info(`[snapshots] ${snapshotName}: build context staged at ${contextDir}`);
  return { contextDir, composedPath, dockerfileName };
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
      `Required directory missing: ${path}. Set ${envVarHint} or ship apps/sandbox/agent-cli.`,
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

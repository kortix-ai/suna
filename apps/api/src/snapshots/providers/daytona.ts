/**
 * Daytona implementation of `SandboxProviderAdapter`.
 *
 * Wraps the Daytona SDK calls used by the rest of the snapshot system: build
 * a snapshot from a composed Dockerfile, query its live state, and delete it.
 * The "layered Dockerfile" composition (user Dockerfile + Kortix runtime
 * layer) is the responsibility of the caller (snapshots/builder.ts) — this
 * adapter only knows about Daytona-specific request shapes and retries.
 */

import { copyFile, cp, mkdtemp, rm, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { tmpdir } from 'node:os';
import { Image } from '@daytonaio/sdk';
import { getDaytona, isDaytonaConfigured } from '../../shared/daytona';
import { buildLayeredDockerfile } from '../dockerfile-layer';
import { shouldIncludeRuntimeArtifactPath } from '../runtime-artifact-filter';
import type {
  BuildableTemplate,
  BuildLogTap,
  ProviderState,
  SandboxProviderAdapter,
} from './index';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../../..');
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
const BUILD_TIMEOUT_MS = 10 * 60 * 1000;
const BUILD_ATTEMPTS = 3;
const BUILD_RETRY_BASE_MS = 2_000;
const SNAPSHOT_LOG_TAIL_LIMIT = 20;
const POST_FAILURE_SETTLE_TIMEOUT_MS = 5 * 60 * 1000;
const POST_FAILURE_SETTLE_POLL_MS = 4_000;
const ACTIVATE_DEADLINE_MS = 120_000;
const DEFAULT_CPU = readPositiveIntEnv('KORTIX_DEFAULT_SANDBOX_CPU', 2);
const DEFAULT_MEMORY_GB = readPositiveIntEnv('KORTIX_DEFAULT_SANDBOX_MEMORY_GB', 4);
const DEFAULT_DISK_GB = readPositiveIntEnv('KORTIX_DEFAULT_SANDBOX_DISK_GB', 20);

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/**
 * Positive-state cache for Daytona snapshots. Keyed by snapshot name; only
 * 'active' is cached. TTL is 60s — long enough to collapse a burst of session
 * boots into one round-trip, short enough that a manual delete in the
 * Daytona dashboard surfaces in under a minute.
 */
const SNAPSHOT_STATE_CACHE_TTL_MS = 60_000;
const snapshotStateCache = new Map<string, { state: ProviderState; expiresAt: number }>();

class DaytonaAdapter implements SandboxProviderAdapter {
  readonly id = 'daytona' as const;

  isConfigured(): boolean {
    return isDaytonaConfigured();
  }

  async buildSnapshot(input: BuildableTemplate, tap?: BuildLogTap): Promise<void> {
    if (!input.image && !input.userDockerfile) {
      throw new Error('DaytonaAdapter.buildSnapshot: neither image nor userDockerfile set');
    }
    const daytona = getDaytona();
    const userDockerfile = input.userDockerfile ?? `FROM ${input.image}\n`;
    const ctx = await this.prepareBuildContext(input.snapshotName, userDockerfile);
    try {
      const resources = {
        cpu: input.spec.cpu ?? DEFAULT_CPU,
        memory: input.spec.memoryGb ?? DEFAULT_MEMORY_GB,
        disk: input.spec.diskGb ?? DEFAULT_DISK_GB,
      };
      console.info(
        `[snapshots] ${input.snapshotName}: building (slug="${input.slug}", provider=daytona, spec=${JSON.stringify(resources)})`,
      );

      let lastErr: unknown;
      for (let attempt = 1; attempt <= BUILD_ATTEMPTS; attempt++) {
        const buildLogs: string[] = [];
        try {
          await daytona.snapshot.create(
            {
              name: input.snapshotName,
              image: Image.fromDockerfile(ctx.composedPath),
              entrypoint: input.entrypoint ?? ['/usr/local/bin/kortix-entrypoint'],
              resources,
            },
            {
              timeout: Math.floor(BUILD_TIMEOUT_MS / 1000),
              onLogs: (chunk) => {
                const line = chunk.trim();
                if (!line) return;
                buildLogs.push(line);
                if (buildLogs.length > SNAPSHOT_LOG_TAIL_LIMIT) {
                  buildLogs.splice(0, buildLogs.length - SNAPSHOT_LOG_TAIL_LIMIT);
                }
                console.info(`[snapshots] ${input.snapshotName}: ${line}`);
                tap?.onLine?.(line);
              },
            },
          );
          await this.waitForActive(input.snapshotName);
          return;
        } catch (err) {
          lastErr = err;
          const settled = await this.waitForSettle(input.snapshotName, POST_FAILURE_SETTLE_TIMEOUT_MS);
          if (settled === 'active') return;
          if (!isTransientDaytonaError(err) || attempt === BUILD_ATTEMPTS) {
            throw new Error(`Snapshot build failed: ${err instanceof Error ? err.message : String(err)}`);
          }
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(
            `[snapshots] build attempt ${attempt}/${BUILD_ATTEMPTS} for ${input.snapshotName} failed transiently — retrying: ${msg.slice(0, 120)}`,
          );
          await new Promise((r) => setTimeout(r, BUILD_RETRY_BASE_MS * attempt));
        }
      }
      throw lastErr;
    } finally {
      await rm(ctx.contextDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async getSnapshotState(snapshotName: string): Promise<ProviderState> {
    if (!isDaytonaConfigured()) return 'missing';
    // 60s positive-state cache. Daytona's snapshot.get is ~50-200ms per call
    // over the public internet; on a burst of session boots this dominates
    // the warm path. We cache only `active` (the common case) because that's
    // the only state where speeding the boot up is safe: if the snapshot is
    // mid-build / removing / missing, the caller's logic depends on the
    // accurate state, and the auto-heal in session-sandbox.ts already covers
    // the rare race where an `active` snapshot disappears between our check
    // and the actual sandbox.create.
    const cached = snapshotStateCache.get(snapshotName);
    if (cached && Date.now() < cached.expiresAt) return cached.state;
    try {
      const snap = await getDaytona().snapshot.get(snapshotName);
      const state = (snap
        ? String((snap as { state?: string }).state ?? 'missing')
        : 'missing'
      ).toLowerCase() as ProviderState;
      if (state === 'active') {
        snapshotStateCache.set(snapshotName, {
          state,
          expiresAt: Date.now() + SNAPSHOT_STATE_CACHE_TTL_MS,
        });
      } else {
        snapshotStateCache.delete(snapshotName);
      }
      return state;
    } catch {
      snapshotStateCache.delete(snapshotName);
      return 'missing';
    }
  }

  async deleteSnapshot(snapshotName: string): Promise<void> {
    if (!isDaytonaConfigured()) return;
    snapshotStateCache.delete(snapshotName); // invalidate before mutating
    try {
      const snap = await getDaytona().snapshot.get(snapshotName);
      if (!snap) return;
      await getDaytona().snapshot.delete(snap);
    } catch {
      // not found / transient — treat as already gone
    }
  }

  private async prepareBuildContext(
    snapshotName: string,
    userDockerfile: string,
  ): Promise<{ contextDir: string; composedPath: string }> {
    await assertExists(AGENT_BIN_PATH, 'KORTIX_SNAPSHOT_AGENT_BIN_PATH');
    await assertExists(CLI_BIN_PATH, 'KORTIX_SNAPSHOT_CLI_BIN_PATH');
    await assertExists(ENTRYPOINT_PATH, 'KORTIX_SNAPSHOT_ENTRYPOINT_PATH');
    await assertExistsDir(AGENT_CLI_SRC_PATH, 'KORTIX_SNAPSHOT_AGENT_CLI_PATH');
    await assertExistsDir(EXECUTOR_SDK_SRC_PATH, 'KORTIX_SNAPSHOT_EXECUTOR_SDK_PATH');

    const contextDir = await mkdtemp(join(tmpdir(), 'kortix-snap-'));
    await gzipFile(AGENT_BIN_PATH, join(contextDir, 'kortix-agent.gz'));
    await gzipFile(CLI_BIN_PATH, join(contextDir, 'kortix.gz'));
    await copyFile(ENTRYPOINT_PATH, join(contextDir, 'kortix-entrypoint'));
    await cp(AGENT_CLI_SRC_PATH, join(contextDir, 'kortix-agent-cli'), {
      recursive: true,
      filter: shouldIncludeRuntimeArtifactPath,
    });
    await cp(EXECUTOR_SDK_SRC_PATH, join(contextDir, 'kortix-executor-sdk'), {
      recursive: true,
      filter: shouldIncludeRuntimeArtifactPath,
    });

    const composedPath = join(contextDir, '.kortix-snapshot.Dockerfile');
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
    // Use Bun.write if available (faster than node fs for small writes); fall
    // back to fs.writeFile so the file works in non-Bun runtimes too.
    if (typeof (globalThis as any).Bun?.write === 'function') {
      await (globalThis as any).Bun.write(composedPath, composed);
    } else {
      const fs = await import('node:fs/promises');
      await fs.writeFile(composedPath, composed);
    }
    console.info(`[snapshots] ${snapshotName}: build context staged at ${contextDir}`);
    return { contextDir, composedPath };
  }

  private async waitForActive(name: string): Promise<void> {
    const deadline = Date.now() + ACTIVATE_DEADLINE_MS;
    let lastState = 'unknown';
    while (Date.now() < deadline) {
      try {
        const snap = await getDaytona().snapshot.get(name);
        lastState = String((snap as { state?: string } | null)?.state ?? 'missing').toLowerCase();
        if (lastState === 'active') return;
        if (lastState === 'error' || lastState === 'build_failed') {
          throw new Error(`Snapshot ${name} is ${lastState}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('build_failed') || message.includes('error')) throw err;
        lastState = message.slice(0, 120) || 'lookup failed';
      }
      await new Promise((r) => setTimeout(r, 1_000));
    }
    throw new Error(`Snapshot ${name} did not become active after create (last state: ${lastState})`);
  }

  private async waitForSettle(
    name: string,
    timeoutMs: number,
  ): Promise<'active' | 'failed' | 'unknown'> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const snap = await getDaytona().snapshot.get(name);
        const state = (snap as { state?: string } | null | undefined)?.state;
        if (state === 'active') return 'active';
        if (state === 'error' || state === 'build_failed') {
          await getDaytona().snapshot.delete(snap as never).catch(() => {});
          return 'failed';
        }
      } catch {
        // transient — keep polling
      }
      await new Promise((r) => setTimeout(r, POST_FAILURE_SETTLE_POLL_MS));
    }
    return 'unknown';
  }
}

function isTransientDaytonaError(err: unknown): boolean {
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  const statusCode = (err as { statusCode?: number } | null | undefined)?.statusCode;
  if (statusCode === 404) return true;
  return (
    m.includes('socket connection') ||
    m.includes('idle connection') ||
    m.includes('not read from or written to') ||
    m.includes('socket hang up') ||
    (m.includes('snapshot with name') && m.includes('not found')) ||
    m.includes('timeout') ||
    m.includes('timed out') ||
    m.includes('econnreset') ||
    m.includes('econnrefused') ||
    m.includes('etimedout') ||
    m.includes('eof') ||
    m.includes('network') ||
    m.includes('gateway') ||
    m.includes('not found') ||
    m.includes(' 502') || m.includes(' 503') || m.includes(' 504')
  );
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

export const daytonaProvider = new DaytonaAdapter();

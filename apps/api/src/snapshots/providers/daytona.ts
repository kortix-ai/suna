/**
 * Daytona implementation of `SandboxProviderAdapter`.
 *
 * Wraps the Daytona SDK calls used by the rest of the snapshot system: build
 * a snapshot from a composed Dockerfile, query its live state, and delete it.
 * The "layered Dockerfile" composition (user Dockerfile + Kortix runtime
 * layer) is the responsibility of the caller (snapshots/builder.ts) — this
 * adapter only knows about Daytona-specific request shapes and retries.
 */

import { rm } from 'node:fs/promises';
import { Image } from '@daytonaio/sdk';
import { getDaytona, isDaytonaConfigured, listDaytonaSnapshots } from '../../shared/daytona';
import { withTimeout } from '../../shared/with-timeout';
import { shortLivedObservation, type InvalidatableObservation } from '../observation-cache';
import {
  stageBuildContext,
  DEFAULT_CPU,
  DEFAULT_MEMORY_GB,
  DEFAULT_DISK_GB,
  KORTIX_ENTRYPOINT,
} from '../build-context';
import { normalizeExistingProviderState } from './state';
import type {
  BuildableTemplate,
  BuildLogTap,
  ProviderState,
  SandboxProviderAdapter,
} from './index';

const BUILD_TIMEOUT_MS = 10 * 60 * 1000;
const BUILD_ATTEMPTS = 3;
const BUILD_RETRY_BASE_MS = 2_000;
const SNAPSHOT_LOG_TAIL_LIMIT = 20;
const POST_FAILURE_SETTLE_TIMEOUT_MS = 5 * 60 * 1000;
const POST_FAILURE_SETTLE_POLL_MS = 4_000;
const ACTIVATE_DEADLINE_MS = 120_000;

/**
 * Positive-state cache for Daytona snapshots. Keyed by snapshot name; only
 * 'active' is cached. TTL is 60s — long enough to collapse a burst of session
 * boots into one round-trip, short enough that a manual delete in the
 * Daytona dashboard surfaces in under a minute.
 */
const SNAPSHOT_STATE_CACHE_TTL_MS = 60_000;
/**
 * Per-call wall-clock budget for the (timeout-less) Daytona `snapshot.get`.
 * A healthy call is ~50-200ms; 8s is generous headroom for a slow-but-alive
 * upstream while keeping us well under the frontend's 30s request timeout even
 * if several templates are checked back-to-back.
 */
const SNAPSHOT_STATE_TIMEOUT_MS = 8_000;
const snapshotStateObservations = new Map<string, InvalidatableObservation<ProviderState>>();

function invalidateSnapshotState(snapshotName: string): void {
  snapshotStateObservations.get(snapshotName)?.invalidate();
  snapshotStateObservations.delete(snapshotName);
}

function observeSnapshotState(snapshotName: string): InvalidatableObservation<ProviderState> {
  const existing = snapshotStateObservations.get(snapshotName);
  if (existing) return existing;
  const observation = shortLivedObservation(
    async (): Promise<ProviderState> => {
      try {
        const snap = await withTimeout(
          getDaytona().snapshot.get(snapshotName),
          SNAPSHOT_STATE_TIMEOUT_MS,
          `Daytona snapshot.get(${snapshotName})`,
        );
        return snap
          ? normalizeExistingProviderState((snap as { state?: string }).state)
          : 'missing';
      } catch (err) {
        if (isDaytonaSnapshotNotFoundError(err)) return 'missing';
        return 'unknown';
      }
    },
    SNAPSHOT_STATE_CACHE_TTL_MS,
    (state) => state === 'active',
  );
  snapshotStateObservations.set(snapshotName, observation);
  return observation;
}

class DaytonaAdapter implements SandboxProviderAdapter {
  readonly id = 'daytona' as const;

  isConfigured(): boolean {
    return isDaytonaConfigured();
  }

  async buildSnapshot(input: BuildableTemplate, tap?: BuildLogTap): Promise<void> {
    if (!input.image && !input.userDockerfile) {
      throw new Error('DaytonaAdapter.buildSnapshot: neither image nor userDockerfile set');
    }
    invalidateSnapshotState(input.snapshotName);
    const daytona = getDaytona();
    const userDockerfile = input.userDockerfile ?? `FROM ${input.image}\n`;
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
      // Re-stage a FRESH build context each attempt. The staged temp dir can be
      // disturbed between staging and the SDK's context upload (e.g. an API
      // restart mid-build on a fast-deploying env, or a tmp sweep), which the SDK
      // reports as "Path does not exist: …/scaffold.git". Re-staging self-heals
      // it so the auto/background build recovers on its own instead of needing a
      // manual rebuild (the "always have to manually start" symptom).
      const ctx = await stageBuildContext(input.snapshotName, userDockerfile, input.warmRepo);
      const buildLogs: string[] = [];
      try {
        await daytona.snapshot.create(
          {
            name: input.snapshotName,
            image: Image.fromDockerfile(ctx.composedPath),
            entrypoint: input.entrypoint ?? [KORTIX_ENTRYPOINT],
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
        invalidateSnapshotState(input.snapshotName);
        return;
      } catch (err) {
        lastErr = err;
        const settled = await this.waitForSettle(input.snapshotName, POST_FAILURE_SETTLE_TIMEOUT_MS);
        if (settled === 'active') {
          invalidateSnapshotState(input.snapshotName);
          return;
        }
        if (!isRetryableBuildError(err) || attempt === BUILD_ATTEMPTS) {
          invalidateSnapshotState(input.snapshotName);
          throw new Error(`Snapshot build failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[snapshots] build attempt ${attempt}/${BUILD_ATTEMPTS} for ${input.snapshotName} failed — re-staging + retrying: ${msg.slice(0, 120)}`,
        );
        await new Promise((r) => setTimeout(r, BUILD_RETRY_BASE_MS * attempt));
      } finally {
        await rm(ctx.contextDir, { recursive: true, force: true }).catch(() => {});
      }
    }
    invalidateSnapshotState(input.snapshotName);
    throw lastErr;
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
    return observeSnapshotState(snapshotName)();
  }

  async deleteSnapshot(snapshotName: string): Promise<void> {
    if (!isDaytonaConfigured()) return;
    invalidateSnapshotState(snapshotName);
    try {
      // Bounded for the same reason as getSnapshotState() above: the Daytona
      // SDK's axios client has a 24h default timeout, so an unbounded call
      // here can hang the caller indefinitely instead of hitting this
      // method's own already-forgiving try/catch.
      const snap = await withTimeout(getDaytona().snapshot.get(snapshotName), SNAPSHOT_STATE_TIMEOUT_MS, `Daytona snapshot.get(${snapshotName})`);
      if (!snap) return;
      await withTimeout(getDaytona().snapshot.delete(snap), SNAPSHOT_STATE_TIMEOUT_MS, `Daytona snapshot.delete(${snapshotName})`);
    } catch (err) {
      if (!isDaytonaSnapshotNotFoundError(err)) throw err;
    } finally {
      invalidateSnapshotState(snapshotName);
    }
  }

  async listSnapshots(): Promise<Array<{ name: string }>> {
    if (!isDaytonaConfigured()) return [];
    return (await listDaytonaSnapshots()).map((snapshot) => ({ name: snapshot.name }));
  }

  private async waitForActive(name: string): Promise<void> {
    const deadline = Date.now() + ACTIVATE_DEADLINE_MS;
    let lastState = 'unknown';
    while (Date.now() < deadline) {
      try {
        // Bounded so one hung poll can't defeat this loop's own deadline
        // check — see deleteSnapshot()'s comment above for why.
        const snap = await withTimeout(getDaytona().snapshot.get(name), SNAPSHOT_STATE_TIMEOUT_MS, `Daytona snapshot.get(${name})`);
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
        // Bounded so one hung poll can't defeat this loop's own deadline
        // check — see deleteSnapshot()'s comment above for why.
        const snap = await withTimeout(getDaytona().snapshot.get(name), SNAPSHOT_STATE_TIMEOUT_MS, `Daytona snapshot.get(${name})`);
        const state = (snap as { state?: string } | null | undefined)?.state;
        if (state === 'active') return 'active';
        if (state === 'error' || state === 'build_failed') {
          await withTimeout(getDaytona().snapshot.delete(snap as never), SNAPSHOT_STATE_TIMEOUT_MS, `Daytona snapshot.delete(${name})`).catch(() => {});
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

export function isDaytonaSnapshotNotFoundError(err: unknown): boolean {
  const value = err as
    | {
        status?: unknown;
        name?: unknown;
        message?: unknown;
        code?: unknown;
        statusCode?: unknown;
        response?: { status?: unknown };
      }
    | null
    | undefined;
  const status = value?.status ?? value?.statusCode ?? value?.code ?? value?.response?.status;
  const name = String(value?.name ?? '').toLowerCase();
  const message = String(value?.message ?? '').toLowerCase();
  return (
    status === 404 ||
    name === 'daytonanotfounderror' ||
    (message.includes('snapshot') && message.includes('not found'))
  );
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

/**
 * A build context can be disturbed AFTER staging but before the SDK uploads it
 * (API restart mid-build on a fast-deploying env, or a tmp sweep), surfacing as
 * a missing COPY source ("Path does not exist: …/scaffold.git") or our own
 * "staging incomplete" guard. Treat as retryable so the next attempt re-stages a
 * fresh context — this is what makes auto/background builds self-heal instead of
 * permanently failing until a manual rebuild.
 */
function isStaleContextError(err: unknown): boolean {
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    m.includes('does not exist') ||
    m.includes('staging incomplete') ||
    m.includes('scaffold') ||
    m.includes('no such file')
  );
}

function isRetryableBuildError(err: unknown): boolean {
  return isTransientDaytonaError(err) || isStaleContextError(err);
}

export const daytonaProvider = new DaytonaAdapter();

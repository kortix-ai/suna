/**
 * Local Docker implementation of `SandboxProviderAdapter` — EXPERIMENTAL.
 *
 * "Build" means: `docker build` the SAME composed Dockerfile every other
 * provider builds (apps/api/src/snapshots/build-context.ts +
 * dockerfile-layer.ts — the user's Dockerfile, or the platform default
 * `FROM ubuntu:24.04`, plus the Kortix runtime layer), against the LOCAL
 * Docker daemon, and tag the result with the content-addressed snapshot name.
 * No registry push — the tag itself, sitting in the local image store, IS the
 * "snapshot".
 *
 * This is a deliberate design choice, not an oversight: it means local-docker
 * needs no pre-built `kortix/kortix-sandbox` base image (that Docker Hub repo
 * does not exist — see the PR description's "image distribution" section) and
 * stays byte-for-byte the same build recipe every other provider uses, which
 * is exactly the invariant build-context.ts documents ("the produced image is
 * byte-identical across providers"). The first build of a given identity is
 * slow (Debian/pip/npm installs, a few minutes) — the SAME real cost Daytona
 * and Platinum already pay building this identical layer remotely — and is
 * cached thereafter like any other provider's snapshot.
 */

import { rm } from 'node:fs/promises';
import Docker from 'dockerode';
import {
  DEFAULT_CPU,
  DEFAULT_MEMORY_GB,
  stageBuildContext,
} from '../build-context';
import { getDockerClient, localDockerSocketLooksPresent } from '../../platform/providers/local-docker';
import { normalizeExistingProviderState } from './state';
import type {
  BuildableTemplate,
  BuildLogTap,
  ProviderState,
  SandboxProviderAdapter,
} from './index';

const REAPABLE_SNAPSHOT_PREFIXES = ['kortix-default-', 'kortix-tpl-', 'kortix-wproj-', 'kortix-ppwarm-'];

function isNotFoundError(err: unknown): boolean {
  const status = (err as { statusCode?: unknown } | null | undefined)?.statusCode;
  if (status === 404) return true;
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return message.includes('no such image') || message.includes('404');
}

/** Build logs stream NDJSON frames; an `error` frame means the build failed
 *  even though the HTTP response itself was 200 (Docker's build API quirk). */
function findBuildErrorFrame(frames: Array<Record<string, unknown>>): string | null {
  for (const frame of frames) {
    if (typeof frame.error === 'string' && frame.error) return frame.error;
    const detail = frame.errorDetail as { message?: unknown } | undefined;
    if (detail && typeof detail.message === 'string' && detail.message) return detail.message;
  }
  return null;
}

class LocalDockerSnapshotAdapter implements SandboxProviderAdapter {
  readonly id = 'local-docker' as const;

  isConfigured(): boolean {
    // Cheap, sync hint only (no daemon round-trip) — matches every other
    // adapter's isConfigured() being a fast, non-blocking check. The real
    // reachability check happens inside buildImage()/getSnapshotState() and
    // fails with a clear, actionable error (see local-docker.ts's
    // assertDockerReachable).
    return localDockerSocketLooksPresent();
  }

  async buildSnapshot(input: BuildableTemplate, tap?: BuildLogTap): Promise<void> {
    if (!input.image && !input.userDockerfile) {
      throw new Error('LocalDockerAdapter.buildSnapshot: neither image nor userDockerfile set');
    }
    const userDockerfile = input.userDockerfile ?? `FROM ${input.image}\n`;
    const docker: Docker = getDockerClient();
    const ctx = await stageBuildContext(input.snapshotName, userDockerfile, input.warmRepo);
    try {
      console.info(
        `[snapshots] ${input.snapshotName}: building (slug="${input.slug}", provider=local-docker, ` +
        `spec=${JSON.stringify({ cpu: input.spec.cpu ?? DEFAULT_CPU, memory: input.spec.memoryGb ?? DEFAULT_MEMORY_GB })})`,
      );
      const stream = await docker.buildImage(
        { context: ctx.contextDir, src: ['.'] },
        { t: input.snapshotName, dockerfile: ctx.dockerfileName, rm: true, forcerm: true },
      );
      const frames = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
        const collected: Array<Record<string, unknown>> = [];
        docker.modem.followProgress(
          stream,
          (err: Error | null, output: Array<Record<string, unknown>>) => {
            if (err) return reject(err);
            resolve(output ?? collected);
          },
          (event: Record<string, unknown>) => {
            collected.push(event);
            const line = typeof event.stream === 'string' ? event.stream.trim() : '';
            if (line) {
              console.info(`[snapshots] ${input.snapshotName} [local-docker]: ${line}`);
              tap?.onLine?.(line);
            }
          },
        );
      });
      const buildError = findBuildErrorFrame(frames);
      if (buildError) {
        throw new Error(`Snapshot build failed: ${buildError}`);
      }
      // Fail loud if the daemon reports success but the tag genuinely isn't
      // there — a silent no-op build is worse than an explicit error.
      await docker.getImage(input.snapshotName).inspect();
    } finally {
      await rm(ctx.contextDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async getSnapshotState(snapshotName: string): Promise<ProviderState> {
    try {
      await getDockerClient().getImage(snapshotName).inspect();
      // A local `docker build` is synchronous within buildSnapshot() above —
      // by the time an inspect succeeds the image is fully built, never
      // partially. There is no external "building" state to observe (unlike
      // Daytona/Platinum's async remote build farms); normalizeExistingProviderState
      // maps the only state we can ever see here ('active') consistently with
      // every other provider's vocabulary.
      return normalizeExistingProviderState('active');
    } catch (err) {
      if (isNotFoundError(err)) return 'missing';
      return 'unknown';
    }
  }

  async deleteSnapshot(snapshotName: string): Promise<void> {
    try {
      await getDockerClient().getImage(snapshotName).remove({ force: true });
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
    }
  }

  async listSnapshots(): Promise<Array<{ name: string }>> {
    const images = await getDockerClient().listImages({});
    const names: string[] = [];
    for (const image of images) {
      for (const tag of image.RepoTags ?? []) {
        const [repo] = tag.split(':');
        if (repo && REAPABLE_SNAPSHOT_PREFIXES.some((prefix) => repo.startsWith(prefix))) {
          names.push(repo);
        }
      }
    }
    return names.map((name) => ({ name }));
  }
}

export const localDockerSnapshotProvider = new LocalDockerSnapshotAdapter();

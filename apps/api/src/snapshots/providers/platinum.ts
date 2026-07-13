/**
 * Platinum implementation of `SandboxProviderAdapter`.
 *
 * Platinum templates ARE the "snapshots" (GET/DELETE /v1/templates). Building
 * does exactly what Daytona does — ship the staged build context (user
 * Dockerfile + Kortix runtime layer) to the provider and let it build
 * server-side. Daytona uses Image.fromDockerfile(); Platinum uses
 * `POST /v1/templates/from-build` (tar.gz of the same context staged by
 * snapshots/build-context.ts, so the produced image is identical). Platinum's
 * host then runs `podman build` + bakes its microVM init/agent, same as its
 * from-spec path.
 */

import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { platinumJson, isPlatinumConfigured } from '../../shared/platinum';
import {
  stageBuildContext,
  stageAgentBinaryGz,
  DEFAULT_CPU,
  DEFAULT_MEMORY_GB,
  DEFAULT_DISK_GB,
  KORTIX_ENTRYPOINT,
} from '../build-context';
import { SANDBOX_SPEC_LIMITS } from '../dockerfile-layer';
import { normalizeExistingProviderState } from './state';
import type {
  BuildableTemplate,
  BuildLogTap,
  ProviderState,
  SandboxProviderAdapter,
} from './index';

const ACTIVATE_DEADLINE_MS = 12 * 60 * 1000; // build + activate ceiling
const POLL_MS = 3_000;
const MB_PER_GB = 1024;
const BUILD_ATTEMPTS = 3;
// Platinum's POST /v1/templates/from-build hard-caps size_mb at this value (see
// platinum apps/api/src/api/templates.ts ORG_MAX_SIZE_MB + the from-build zod).
// The build ext4 is a FLOOR Platinum grows-to-fit, so clamping the build ceiling
// does NOT shrink the runtime disk (default_disk_gb stays the full spec) — it only
// stops oversize-disk templates from being rejected with a raw "size_mb too_big"
// 400. Single source of truth for the build-size contract; keep in sync w/ Platinum.
export const PLATINUM_MAX_BUILD_SIZE_MB = 20480;

/**
 * Retry only stale-context (staging disturbed before the S3 upload — API restart
 * mid-build / tmp sweep) and transient transport (S3 PUT / gateway). A real build
 * failure ('template … build failed') or activate timeout is NOT retried — that's
 * a genuine error, not something a fresh stage would fix.
 */
function isRetryablePlatinumBuildError(err: unknown): boolean {
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    m.includes('does not exist') || m.includes('staging incomplete') || m.includes('scaffold') ||
    m.includes('no such file') || m.includes('s3 upload') || m.includes('tar build context') ||
    m.includes('timeout') || m.includes('timed out') || m.includes('econnreset') ||
    m.includes('econnrefused') || m.includes('network') || m.includes('gateway') ||
    m.includes(' 502') || m.includes(' 503') || m.includes(' 504')
  );
}

interface PlatinumTemplate {
  id: string;
  name?: string;
  state?: string;
  error?: string | null;
  build_error?: string | null;
  status_message?: string | null;
}

async function findTemplateByName(name: string): Promise<PlatinumTemplate | null> {
  const list = await platinumJson<PlatinumTemplate[]>('/v1/templates');
  return list.find((t) => t.name === name) ?? null;
}

class PlatinumAdapter implements SandboxProviderAdapter {
  readonly id = 'platinum' as const;

  isConfigured(): boolean {
    return isPlatinumConfigured();
  }

  async buildSnapshot(input: BuildableTemplate, tap?: BuildLogTap): Promise<void> {
    if (!input.image && !input.userDockerfile) {
      throw new Error('PlatinumAdapter.buildSnapshot: neither image nor userDockerfile set');
    }
    const userDockerfile = input.userDockerfile ?? `FROM ${input.image}\n`;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= BUILD_ATTEMPTS; attempt++) {
      try {
        await this.buildOnce(input, userDockerfile, tap);
        return;
      } catch (err) {
        lastErr = err;
        if (!isRetryablePlatinumBuildError(err) || attempt === BUILD_ATTEMPTS) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[snapshots] platinum build attempt ${attempt}/${BUILD_ATTEMPTS} for ${input.snapshotName} failed — re-staging + retrying: ${msg.slice(0, 120)}`,
        );
        await new Promise((r) => setTimeout(r, 2_000 * attempt));
      }
    }
    throw lastErr;
  }

  /** One build attempt: stage a FRESH context, ship it, register, wait active.
   *  Re-staged per attempt by buildSnapshot so a context disturbed between
   *  staging and the S3 upload self-heals (mirrors the daytona adapter). */
  private async buildOnce(input: BuildableTemplate, userDockerfile: string, tap?: BuildLogTap): Promise<void> {
    // Stage the SAME context Daytona builds (Dockerfile + agent/cli/entrypoint/…).
    const ctx = await stageBuildContext(input.snapshotName, userDockerfile, input.warmRepo);
    const tarPath = join(ctx.contextDir, '..', `${input.snapshotName.replace(/[^a-zA-Z0-9_.-]/g, '_')}.tar.gz`);
    try {
      const tar = Bun.spawn(['tar', '-czf', tarPath, '-C', ctx.contextDir, '.']);
      if ((await tar.exited) !== 0) throw new Error('tar build context failed');

      // Contexts are 100s of MB (baked agent + CLI binaries) — too big for the
      // API gateway's body cap, so upload DIRECTLY to object storage via a
      // presigned PUT (phase 1 + 2), then register the build (phase 3). The
      // build itself still happens server-side on Platinum (podman build).
      console.info(`[snapshots] ${input.snapshotName}: presign + upload build context to Platinum (slug="${input.slug}")`);
      const { upload_url, context_s3_key } = await platinumJson<{ upload_url: string; context_s3_key: string }>(
        '/v1/templates/from-build/presign', { method: 'POST', body: JSON.stringify({}) },
      );
      // STREAM the upload — Bun.file() sends the tarball in chunks, so a
      // 100s-of-MB context uploads in constant memory. The previous
      // new Uint8Array(await readFile()) buffered the ENTIRE tarball (twice) in
      // RAM and OOMKilled the 512Mi api pod (exit 137), 502-ing every session
      // whose request hit the crashing replica. Daytona never buffers — its SDK
      // streams the context — so this brings the Platinum path to parity.
      const put = await fetch(upload_url, { method: 'PUT', body: Bun.file(tarPath) });
      if (!put.ok) throw new Error(`build-context S3 upload -> ${put.status} ${(await put.text().catch(() => '')).slice(0, 200)}`);

      const diskGb = Math.min(input.spec.diskGb ?? DEFAULT_DISK_GB, SANDBOX_SPEC_LIMITS.disk.max);

      await platinumJson<PlatinumTemplate>('/v1/templates/from-build', {
        method: 'POST',
        body: JSON.stringify({
          name: input.snapshotName,
          context_s3_key,
          dockerfile: ctx.dockerfileName,
          // Build-time ext4 ceiling, clamped to Platinum's from-build hard cap.
          // Platinum grows ext4 to fit, so the artifact consumes only image+headroom
          // (a ~9.4 GiB kortix image builds fine into a 20 GiB ceiling). The runtime
          // disk (default_disk_gb below) stays the FULL spec — build ceiling != runtime
          // disk. Without this clamp a >20 GiB-disk template 400s ("size_mb too_big").
          size_mb: Math.min(diskGb * MB_PER_GB, PLATINUM_MAX_BUILD_SIZE_MB),
          default_cpu: input.spec.cpu ?? DEFAULT_CPU,
          default_ram_mb: (input.spec.memoryGb ?? DEFAULT_MEMORY_GB) * 1024,
          default_disk_gb: diskGb,
          entrypoint: (input.entrypoint ?? [KORTIX_ENTRYPOINT]).join(' '),
        }),
      });
      await this.waitForActive(input.snapshotName, tap);
    } finally {
      await rm(ctx.contextDir, { recursive: true, force: true }).catch(() => {});
      await rm(tarPath, { force: true }).catch(() => {});
    }
  }

  /**
   * Agent-only fast path: build NEW snapshot from a PREDECESSOR snapshot by
   * swapping ONLY the kortix-agent binary inside its rootfs (no podman rebuild).
   * Ships just the agent .gz via the same presign path; the host debugfs-swaps it
   * into the predecessor's materialized rootfs + re-chunks (CAS delta). The caller
   * uses this ONLY when the user image is unchanged AND the predecessor is active
   * on Platinum — otherwise it falls back to a normal buildSnapshot.
   */
  async swapAgent(newSnapshotName: string, sourceSnapshotName: string): Promise<void> {
    const { gzPath, cleanup } = await stageAgentBinaryGz();
    try {
      const { upload_url, context_s3_key } = await platinumJson<{ upload_url: string; context_s3_key: string }>(
        '/v1/templates/from-build/presign', { method: 'POST', body: JSON.stringify({}) },
      );
      const put = await fetch(upload_url, { method: 'PUT', body: Bun.file(gzPath) }); // streamed — see buildOnce
      if (!put.ok) throw new Error(`agent-swap upload -> ${put.status} ${(await put.text().catch(() => '')).slice(0, 200)}`);
      // Platinum's GENERAL file-patch primitive: patch our one changed file (the
      // kortix-agent binary) into the predecessor's rootfs — no rebuild. The guest
      // path is OURS to specify (Platinum is file-agnostic); /usr/local/bin/kortix-agent
      // is where our runtime layer (dockerfile-layer.ts) installs it. mode 0100755 =
      // executable (debugfs `write` lands 0644 otherwise).
      await platinumJson<PlatinumTemplate>('/v1/templates/from-patch', {
        method: 'POST',
        body: JSON.stringify({
          name: newSnapshotName,
          source_template_name: sourceSnapshotName,
          files: [{ s3_key: context_s3_key, guest_path: '/usr/local/bin/kortix-agent', mode: 0o100755 }],
        }),
      });
      await this.waitForActive(newSnapshotName);
    } finally {
      await cleanup();
    }
  }

  async getSnapshotState(snapshotName: string): Promise<ProviderState> {
    if (!isPlatinumConfigured()) return 'missing';
    try {
      const template = await findTemplateByName(snapshotName);
      return template ? normalizeExistingProviderState(template.state) : 'missing';
    } catch {
      return 'unknown';
    }
  }

  async deleteSnapshot(snapshotName: string): Promise<void> {
    if (!isPlatinumConfigured()) return;
    try {
      const tpl = await findTemplateByName(snapshotName);
      if (!tpl) return;
      await platinumJson(`/v1/templates/${tpl.id}`, { method: 'DELETE' });
    } catch {
      // not found / transient — treat as already gone
    }
  }

  async listSnapshots(): Promise<Array<{ name: string }>> {
    if (!isPlatinumConfigured()) return [];
    return (await platinumJson<PlatinumTemplate[]>('/v1/templates'))
      .map((template) => template.name)
      .filter((name): name is string => !!name)
      .map((name) => ({ name }));
  }

  private async waitForActive(name: string, tap?: BuildLogTap): Promise<void> {
    const deadline = Date.now() + ACTIVATE_DEADLINE_MS;
    let last = 'unknown';
    while (Date.now() < deadline) {
      const tpl = await findTemplateByName(name).catch(() => null);
      const state = (tpl?.state ?? 'missing').toLowerCase();
      if (state !== last) { last = state; tap?.onLine?.(`template ${name}: ${state}`); }
      if (state === 'ready') return;
      if (state === 'failed') {
        const detail = tpl?.build_error ?? tpl?.error ?? tpl?.status_message;
        throw new Error(
          `Platinum template ${name} build failed${detail ? `: ${detail}` : ''}`,
        );
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    throw new Error(`Platinum template ${name} did not become ready (last state: ${last})`);
  }
}

export const platinumProvider = new PlatinumAdapter();

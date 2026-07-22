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
import { shortLivedObservation } from '../observation-cache';

const ACTIVATE_DEADLINE_MS = 12 * 60 * 1000; // build + activate ceiling
const POLL_MS = 3_000;
const MB_PER_GB = 1024;
const BUILD_ATTEMPTS = 3;
const UPLOAD_ATTEMPTS = 3;
const UPLOAD_MIN_TIMEOUT_MS = 10 * 60_000;
const UPLOAD_TIMEOUT_MS_PER_GIB = 60_000;
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
 * failure ('template … build failed') is NOT retried — that's a genuine error,
 * not something a fresh stage would fix.
 *
 * One activate-timeout shape IS retried: `waitForActive` throwing "did not
 * become ready (last state: missing)" means the template NEVER appeared via
 * `GET /v1/templates` for the entire ACTIVATE_DEADLINE_MS poll window — not
 * "building", not "failed", just never registered at all. That is distinct
 * from an explicit 'failed' state (a genuine build error, never retried here)
 * and points at a registration-pipeline flake on Platinum's side rather than a
 * real build problem with this content. Verified empirically during a
 * 2026-07-18 dev incident: a `from-build` registration silently never
 * produced a template (stuck ~15min on `state: missing`, dev sandbox_id
 * 5771eb57-b0be-4579-8e33-93776a66f4fe), while a fresh build attempt for a
 * different content hash minutes later succeeded on its very first try — so a
 * same-process retry is a real, bounded (BUILD_ATTEMPTS) mitigation, not a
 * blind retry-forever. A build that reaches any OTHER observed state
 * ('building', 'pending', …) before failing is a real failure and still
 * excluded, same as 'failed'.
 */
export function isRetryablePlatinumBuildError(err: unknown): boolean {
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    m.includes('does not exist') || m.includes('staging incomplete') || m.includes('scaffold') ||
    m.includes('no such file') || m.includes('s3 upload') || m.includes('tar build context') ||
    m.includes('timeout') || m.includes('timed out') || m.includes('econnreset') ||
    m.includes('econnrefused') || m.includes('network') || m.includes('gateway') ||
    m.includes(' 502') || m.includes(' 503') || m.includes(' 504') ||
    // Rate limiting is transient by definition — failing the build on a 429
    // re-queues the whole bake later, generating more traffic, not less.
    m.includes(' 429') || m.includes('too many requests') ||
    m.includes('last state: missing')
  );
}

interface PlatinumTemplate {
  id: string;
  name?: string;
  state?: string;
}

async function findTemplateByName(name: string): Promise<PlatinumTemplate | null> {
  const list = await observeTemplates();
  return list.find((t) => t.name === name) ?? null;
}

const observeTemplates = shortLivedObservation(
  () => platinumJson<PlatinumTemplate[]>('/v1/templates'),
  process.env.NODE_ENV === 'test' ? 0 : 2_000,
);

/**
 * Direct GET /v1/templates/:id lookup — the PRIMARY signal `waitForActive`
 * polls once `from-build`/`from-patch` has handed back an id. Unlike the
 * name-list (`GET /v1/templates`, limit=50 created_at DESC — see the module
 * header), this reads the exact row Platinum just created, so it can never
 * miss it behind pagination. A 404 here is expected for a brief window right
 * after registration (the row can lag its own id becoming visible) — treat it
 * as "not ready yet", same as any other not-yet-ready state, and let the
 * caller's deadline (not this single lookup) decide when to give up.
 */
async function findTemplateById(id: string): Promise<PlatinumTemplate | null> {
  try {
    return await platinumJson<PlatinumTemplate>(`/v1/templates/${id}`);
  } catch (err) {
    if (/ -> 404(?:\s|$)/.test(err instanceof Error ? err.message : String(err))) return null;
    throw err;
  }
}

/**
 * Long-poll a just-registered template to `ready`. PRIMARY signal is
 * `GET /v1/templates/:id` when `from-build`/`from-patch` returned an id — the
 * name-list lookup is a FALLBACK for the (defensive) case no id is available.
 * Polling the list here would risk exactly the false-negative this function
 * exists to avoid: Platinum's idempotent-adopt path can hand back an OLD row,
 * and the list truncates at 50 (see module header), so a template that exists
 * and is `ready` can still be absent from the page this call sees. Standalone
 * (not a class method) so it's directly unit-testable without driving the
 * whole build pipeline.
 */
export async function waitForActive(name: string, tap?: BuildLogTap, id?: string): Promise<void> {
  const deadline = Date.now() + ACTIVATE_DEADLINE_MS;
  let last = 'unknown';
  while (Date.now() < deadline) {
    const tpl = id ? await findTemplateById(id).catch(() => null) : await findTemplateByName(name).catch(() => null);
    const state = (tpl?.state ?? 'missing').toLowerCase();
    if (state !== last) { last = state; tap?.onLine?.(`template ${name}: ${state}`); }
    if (state === 'ready') return;
    if (state === 'failed') throw new Error(`Platinum template ${name} build failed`);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw new Error(`Platinum template ${name} did not become ready (last state: ${last})`);
}

/** 408 (S3 idle-timeout), our own AbortSignal timeout, and 5xx are transient
 *  — worth a fresh presign + retry. Anything else (400/401/403/404/...) is a
 *  real error and must NOT be retried. */
function isRetryableUploadError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
  const status = Number(err.message.match(/-> (\d{3})\b/)?.[1]);
  return status === 408 || status >= 500;
}

/**
 * Presigned-PUT build-context uploader, hardened against Scaleway S3's idle
 * timeout on large (100s-of-MB) contexts: a mid-transfer stall used to trip a
 * bare 408 with no retry, forcing a full re-upload (or failing the build
 * outright) further up in `isRetryablePlatinumBuildError`'s BUILD_ATTEMPTS
 * loop. Two things fix that here instead: (1) a per-attempt timeout scaled to
 * file size, so a genuinely-large upload isn't cut off before it could ever
 * finish; (2) on a transient failure (408 / timeout / 5xx), RE-PRESIGN for a
 * fresh `upload_url` + `context_s3_key` rather than retrying the same
 * (possibly already-consumed) presigned URL. The returned `context_s3_key` is
 * whichever attempt actually succeeded — callers MUST register that key, not
 * the one from their original presign call, or they'll upload to key A and
 * tell `from-build`/`from-patch` to look for key B.
 *
 * `presignFn()` itself is called INSIDE the try/catch (not before it): a
 * transient failure of the presign call (e.g. a 500/timeout from Platinum's
 * own `/v1/templates/from-build/presign`) is a real-world possibility, same
 * transport as the PUT, and must go through the same isRetryableUploadError
 * decision + retry loop — not bypass it and fail the whole upload on attempt 1.
 */
export async function uploadWithRetry(
  presignFn: () => Promise<{ upload_url: string; context_s3_key: string }>,
  tarPath: string,
): Promise<string> {
  const sizeBytes = Bun.file(tarPath).size;
  const timeoutMs = Math.max(UPLOAD_MIN_TIMEOUT_MS, Math.ceil((sizeBytes / 1024 ** 3) * UPLOAD_TIMEOUT_MS_PER_GIB));
  for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt++) {
    try {
      const { upload_url, context_s3_key } = await presignFn();
      const put = await fetch(upload_url, { method: 'PUT', body: Bun.file(tarPath), signal: AbortSignal.timeout(timeoutMs) });
      if (put.ok) return context_s3_key;
      throw new Error(`build-context S3 upload -> ${put.status} ${(await put.text().catch(() => '')).slice(0, 200)}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!isRetryableUploadError(err) || attempt === UPLOAD_ATTEMPTS) {
        throw new Error(`build-context upload failed after ${attempt}/${UPLOAD_ATTEMPTS} attempt(s): ${msg}`);
      }
      console.warn(`[snapshots] platinum build-context upload attempt ${attempt}/${UPLOAD_ATTEMPTS} failed — re-presigning + retrying: ${msg.slice(0, 160)}`);
      await new Promise((r) => setTimeout(r, 2_000 * attempt));
    }
  }
  // Unreachable: the loop above always returns or throws by UPLOAD_ATTEMPTS.
  throw new Error('build-context upload failed');
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
      observeTemplates.invalidate();
      try {
        await this.buildOnce(input, userDockerfile, tap);
        observeTemplates.invalidate();
        return;
      } catch (err) {
        observeTemplates.invalidate();
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
    const ctx = await stageBuildContext(input.snapshotName, userDockerfile, input.warmRepo, input.isShared);
    const tarPath = join(ctx.contextDir, '..', `${input.snapshotName.replace(/[^a-zA-Z0-9_.-]/g, '_')}.tar.gz`);
    try {
      const tar = Bun.spawn(['tar', '-czf', tarPath, '-C', ctx.contextDir, '.']);
      if ((await tar.exited) !== 0) throw new Error('tar build context failed');

      // Contexts are 100s of MB (baked agent + CLI binaries) — too big for the
      // API gateway's body cap, so upload DIRECTLY to object storage via a
      // presigned PUT (phase 1 + 2), then register the build (phase 3). The
      // build itself still happens server-side on Platinum (podman build).
      console.info(`[snapshots] ${input.snapshotName}: presign + upload build context to Platinum (slug="${input.slug}")`);
      // STREAM the upload — Bun.file() sends the tarball in chunks, so a
      // 100s-of-MB context uploads in constant memory. The previous
      // new Uint8Array(await readFile()) buffered the ENTIRE tarball (twice) in
      // RAM and OOMKilled the 512Mi api pod (exit 137), 502-ing every session
      // whose request hit the crashing replica. Daytona never buffers — its SDK
      // streams the context — so this brings the Platinum path to parity.
      // uploadWithRetry re-presigns + retries on a transient S3 408/timeout/5xx
      // (see its doc comment) — context_s3_key below is whichever attempt won.
      const context_s3_key = await uploadWithRetry(
        () => platinumJson<{ upload_url: string; context_s3_key: string }>(
          '/v1/templates/from-build/presign', { method: 'POST', body: JSON.stringify({}) },
        ),
        tarPath,
      );

      const diskGb = Math.min(input.spec.diskGb ?? DEFAULT_DISK_GB, SANDBOX_SPEC_LIMITS.disk.max);

      const registered = await platinumJson<PlatinumTemplate>('/v1/templates/from-build', {
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
      // Poll the id `from-build` handed back (primary signal) — see waitForActive.
      await waitForActive(input.snapshotName, tap, registered?.id);
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
    observeTemplates.invalidate();
    const { gzPath, cleanup } = await stageAgentBinaryGz();
    try {
      // uploadWithRetry — streamed + retried on transient S3 failure; see buildOnce.
      const context_s3_key = await uploadWithRetry(
        () => platinumJson<{ upload_url: string; context_s3_key: string }>(
          '/v1/templates/from-build/presign', { method: 'POST', body: JSON.stringify({}) },
        ),
        gzPath,
      );
      // Platinum's GENERAL file-patch primitive: patch our one changed file (the
      // kortix-agent binary) into the predecessor's rootfs — no rebuild. The guest
      // path is OURS to specify (Platinum is file-agnostic); /usr/local/bin/kortix-agent
      // is where our runtime layer (dockerfile-layer.ts) installs it. mode 0100755 =
      // executable (debugfs `write` lands 0644 otherwise).
      const patched = await platinumJson<PlatinumTemplate>('/v1/templates/from-patch', {
        method: 'POST',
        body: JSON.stringify({
          name: newSnapshotName,
          source_template_name: sourceSnapshotName,
          files: [{ s3_key: context_s3_key, guest_path: '/usr/local/bin/kortix-agent', mode: 0o100755 }],
        }),
      });
      await waitForActive(newSnapshotName, undefined, patched?.id);
    } finally {
      observeTemplates.invalidate();
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
    observeTemplates.invalidate();
    try {
      const tpl = await findTemplateByName(snapshotName);
      if (!tpl) return;
      await platinumJson(`/v1/templates/${tpl.id}`, { method: 'DELETE' });
    } catch (err) {
      // A lookup/delete race is equivalent to already gone. Provider outages
      // must propagate so fan-out reports this provider as failed.
      if (!/ -> 404(?:\s|$)/.test(err instanceof Error ? err.message : String(err))) {
        throw err;
      }
    } finally {
      observeTemplates.invalidate();
    }
  }

  async listSnapshots(): Promise<Array<{ name: string }>> {
    if (!isPlatinumConfigured()) return [];
    return (await platinumJson<PlatinumTemplate[]>('/v1/templates'))
      .map((template) => template.name)
      .filter((name): name is string => !!name)
      .map((name) => ({ name }));
  }
}

export const platinumProvider = new PlatinumAdapter();

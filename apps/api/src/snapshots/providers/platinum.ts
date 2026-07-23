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
import {
  assertSafePresignedUploadUrl,
  parseUploadHostAllowlist,
  sanitizeUrlForLog,
} from './upload-url-guard';
import {
  classifyPlatinumPollError,
  isTerminalPollError,
  retryAfterMsFromError,
} from './platinum-poll-classify';
import { config } from '../../config';

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

const POLL_BACKOFF_BASE_MS = 2_000;
const POLL_BACKOFF_MAX_MS = 30_000;

/** Exponential backoff with full jitter for transient poll errors. */
function pollBackoffMs(streak: number): number {
  const ceil = Math.min(POLL_BACKOFF_MAX_MS, POLL_BACKOFF_BASE_MS * 2 ** Math.max(0, streak - 1));
  return Math.floor(Math.random() * ceil);
}

/**
 * Long-poll a just-registered template to `ready`. PRIMARY (and, per PHASE 2,
 * the ONLY) signal is `GET /v1/templates/:id` — a non-empty id from
 * `from-build`/`from-patch` is REQUIRED; the truncated name-list fallback is
 * gone (an idempotent-adopt can hand back an OLD row, and the list truncates at
 * 50, so a `ready` template can be absent from the page — a false "missing").
 *
 * Poll-error handling is classified (PHASE 2): 401/403 and TLS/cert failures
 * fail immediately (permanent); 404 is "not visible yet" (healthy, keep
 * polling); 429/5xx/DNS/socket/timeout are transient and retried with
 * exponential backoff + jitter (Retry-After honored on 429) WITHOUT counting
 * against anything — a long healthy `building` is not a failed attempt. Only an
 * explicit provider `failed` state, or the overall deadline, is terminal.
 *
 * When an id is polled, the resolved row's NAME is verified against `name`
 * (defense against an idempotent-adopt returning a different template).
 * Standalone (not a class method) so it's directly unit-testable.
 */
export async function waitForActive(name: string, tap?: BuildLogTap, id?: string): Promise<void> {
  const deadline = Date.now() + ACTIVATE_DEADLINE_MS;
  let last = 'unknown';
  let transientStreak = 0;
  while (Date.now() < deadline) {
    // Renew the caller's lease (if any) BEFORE polling. Placed OUTSIDE the poll
    // try/catch so a heartbeat that reports lost ownership (throws) STOPS the
    // wait rather than being swallowed as a transient poll error. The callback
    // itself swallows transient DB blips (see the drive's heartbeat wrapper), so
    // a throw here is an authoritative "you no longer own this" — the build we're
    // waiting on is now another owner's to finish.
    await tap?.heartbeat?.();
    let tpl: PlatinumTemplate | null;
    try {
      // findTemplateById returns null ONLY on an explicit 404 (not-visible-yet);
      // every other transport/HTTP error propagates here to be classified.
      tpl = id ? await findTemplateById(id) : await findTemplateByName(name);
      transientStreak = 0;
    } catch (err) {
      const cls = classifyPlatinumPollError(err);
      if (isTerminalPollError(cls)) {
        // 401/403 (dead key) or TLS/cert failure — fail NOW, preserving the
        // original classified message so the transition core marks it permanent.
        throw err instanceof Error ? err : new Error(String(err));
      }
      transientStreak += 1;
      const backoff = cls === 'rate-limited'
        ? (retryAfterMsFromError(err) ?? pollBackoffMs(transientStreak))
        : pollBackoffMs(transientStreak);
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      tap?.onLine?.(`template ${name}: transient poll error (${cls}) — retrying`);
      await new Promise((r) => setTimeout(r, Math.max(0, Math.min(backoff, remaining))));
      continue;
    }
    // A resolved-by-id row whose name doesn't match is an adopt mismatch, not
    // our build — fail closed rather than trust a wrong template.
    if (id && tpl && tpl.name && tpl.name !== name) {
      throw new Error(
        `Platinum template id ${id} resolved to name "${tpl.name}", expected "${name}" — refusing to trust a mismatched template`,
      );
    }
    const state = (tpl?.state ?? 'missing').toLowerCase();
    if (state !== last) { last = state; tap?.onLine?.(`template ${name}: ${state}`); }
    if (state === 'ready') return;
    if (state === 'failed') throw new Error(`Platinum template ${name} build failed`);
    // building / pending / missing(=not-visible-yet) → healthy waiting.
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw new Error(`Platinum template ${name} did not become ready (last state: ${last})`);
}

/** Assert a provider-returned external template id is present and non-empty —
 *  PHASE 2 EXACT ID: never fall back to the truncated name list. */
export function requireExternalTemplateId(id: unknown, context: string): string {
  if (typeof id !== 'string' || id.trim() === '') {
    throw new Error(
      `Platinum ${context} did not return a template id — refusing to fall back to name-list polling`,
    );
  }
  return id;
}

/**
 * True iff `err` is a genuine auth/authorization failure from `platinumJson`
 * (`platinum <method> <path> -> 401 …` / `-> 403 …`) — a dead/revoked API key,
 * never a transient provider hiccup. Distinguishing this HERE (at the HTTP
 * layer) matters because `getSnapshotState` below used to swallow EVERY
 * lookup error into the generic `'unknown'` state, which the provider-
 * migration workflow's `interpretImageReadiness` correctly treats as
 * `'indeterminate'` (never "missing" — good) but which then gets reported to
 * `isPermanentTransitionError` as a plain, message-less
 * "provider state indeterminate" error — losing the 401/403 entirely, so a
 * dead key was misclassified as transient and retried for ~5 backed-off
 * attempts before dead-lettering with the WRONG error class (`exhausted`
 * instead of `auth_terminal`). Rethrowing ONLY this narrow, unambiguous class
 * preserves the original `platinumJson` message (which the transition core's
 * `isPermanentTransitionError` already recognizes via ' 401'/' 403') so an
 * auth failure fails FAST and CORRECTLY classified; every other lookup error
 * (network blip, 5xx, timeout) keeps the existing 'unknown' behavior so
 * session-boot and template-cache callers are unaffected.
 */
function isPlatinumAuthFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /-> (401|403)\b/.test(err.message);
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
/**
 * Guard options for the presigned upload URL, derived from deployment env:
 *  - local-dev (`INTERNAL_KORTIX_ENV=dev`) allows http + loopback (MinIO),
 *  - `KORTIX_PLATINUM_UPLOAD_HOST_ALLOWLIST` pins the object-storage origin(s).
 * Exported so the uploader default and tests share one source of truth.
 */
export function uploadUrlGuardOptsFromEnv(): { allowLocal: boolean; allowedHosts: string[] } {
  return {
    allowLocal: config.INTERNAL_KORTIX_ENV === 'dev',
    allowedHosts: parseUploadHostAllowlist(process.env.KORTIX_PLATINUM_UPLOAD_HOST_ALLOWLIST),
  };
}

export async function uploadWithRetry(
  presignFn: () => Promise<{ upload_url: string; context_s3_key: string }>,
  tarPath: string,
  guardOpts: { allowLocal: boolean; allowedHosts: string[] } = uploadUrlGuardOptsFromEnv(),
): Promise<string> {
  const sizeBytes = Bun.file(tarPath).size;
  const timeoutMs = Math.max(UPLOAD_MIN_TIMEOUT_MS, Math.ceil((sizeBytes / 1024 ** 3) * UPLOAD_TIMEOUT_MS_PER_GIB));
  for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt++) {
    try {
      const { upload_url, context_s3_key } = await presignFn();
      // PHASE 2: validate the presigned URL BEFORE streaming the context —
      // https-only outside local-dev, no loopback/link-local/private/multicast
      // SSRF targets, and origin-pinned when an allowlist is configured. An
      // invalid URL is NOT retryable (a fresh presign returns the same origin).
      let safeUrl: URL;
      try {
        safeUrl = assertSafePresignedUploadUrl(upload_url, guardOpts);
      } catch (guardErr) {
        // Wrap as a terminal (non-retryable) error — the sanitized message
        // never carries the presign signature.
        throw new UploadUrlRejectedError(guardErr instanceof Error ? guardErr.message : String(guardErr));
      }
      const put = await fetch(safeUrl, {
        method: 'PUT',
        body: Bun.file(tarPath),
        signal: AbortSignal.timeout(timeoutMs),
        // Refuse a 30x bounce of the signed PUT to a different origin.
        redirect: 'error',
      });
      if (put.ok) return context_s3_key;
      // Log only the sanitized URL (query/signature stripped).
      throw new Error(
        `build-context S3 upload -> ${put.status} ${(await put.text().catch(() => '')).slice(0, 200)} (${sanitizeUrlForLog(upload_url)})`,
      );
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

/** A presigned upload URL that failed the security guard — terminal, never
 *  retried (a re-presign returns the same rejected origin/scheme). */
export class UploadUrlRejectedError extends Error {
  constructor(message: string) {
    super(`presigned upload URL rejected: ${message}`);
    this.name = 'UploadUrlRejectedError';
  }
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
      // PHASE 2 EXACT ID: from-build MUST hand back a non-empty template id. We
      // poll THAT id (never the truncated name list) — see waitForActive.
      const externalId = requireExternalTemplateId(registered?.id, `from-build for ${input.snapshotName}`);
      await waitForActive(input.snapshotName, tap, externalId);
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
      // PHASE 2 EXACT ID: from-patch MUST return a non-empty id — poll it, never
      // the name list.
      const externalId = requireExternalTemplateId(patched?.id, `from-patch for ${newSnapshotName}`);
      await waitForActive(newSnapshotName, undefined, externalId);
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
    } catch (err) {
      // See isPlatinumAuthFailure's doc comment: a dead/revoked key must
      // propagate so callers (the provider-migration workflow) classify it as
      // PERMANENT, not silently degrade to 'unknown' → indeterminate → retry.
      if (isPlatinumAuthFailure(err)) throw err;
      return 'unknown';
    }
  }

  /**
   * Resolve the EXACT Platinum template id backing a built snapshot name — the
   * durable "external_template_id" a provider-migration transition tracks (spec:
   * track by the id Platinum returns, not a truncated name listing). Best-effort
   * audit provenance: the AUTHORITATIVE readiness signal remains
   * getSnapshotState; a null here just means the id couldn't be resolved right
   * now (never a failure). Once #5207's by-id build wait lands, the build itself
   * already polls this id internally — this method only persists it for the
   * transition record + reconciler re-verification.
   */
  async getSnapshotExternalId(snapshotName: string): Promise<string | null> {
    if (!isPlatinumConfigured()) return null;
    try {
      const template = await findTemplateByName(snapshotName);
      return template?.id ?? null;
    } catch {
      return null;
    }
  }

  /**
   * PHASE 2 EXACT ID: verify readiness by the durable EXTERNAL template id (what
   * a transition persisted), not the name. `GET /v1/templates/:id` reads the
   * exact row Platinum created, so it can never miss it behind the 50-row
   * name-list pagination. A 404 = the id is gone → 'missing'. An auth failure
   * propagates (same rationale as getSnapshotState) so a dead key is classified
   * permanent rather than degraded to 'unknown'. Used by the reconciler to
   * re-verify an activated transition against its recorded id.
   */
  async getSnapshotStateByExternalId(externalId: string): Promise<ProviderState> {
    if (!isPlatinumConfigured()) return 'missing';
    if (!externalId || externalId.trim() === '') return 'missing';
    try {
      const template = await findTemplateById(externalId);
      return template ? normalizeExistingProviderState(template.state) : 'missing';
    } catch (err) {
      if (isPlatinumAuthFailure(err)) throw err;
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

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
import {
  stageAgentBinaryGz,
  DEFAULT_CPU,
  DEFAULT_MEMORY_GB,
  DEFAULT_DISK_GB,
  KORTIX_ENTRYPOINT,
  stageRuntimeBuildContext,
} from '../build-context';
import { SANDBOX_SPEC_LIMITS } from '../dockerfile-layer';
import { tarBuildContext } from '../staging-tar';
import { normalizeExistingProviderState } from './state';
import { productionPlatinumClient, observeTemplates, findTemplateByName, findTemplateById, paginateTemplates, fetchAllTemplates, lookupTemplatesNamed, waitForActive, requireExternalTemplateId, isPlatinumAuthFailure, PlatinumTemplateBuildFailedError, PLATINUM_BUILD_FAILED_RE } from './platinum-templates';
import type { PlatinumClient, PlatinumTemplate } from './platinum-templates';
import { uploadWithRetry, templateInUseCount } from './platinum-upload';
export { PlatinumTemplateListingError, PlatinumTemplateBuildFailedError, summarizePlatinumBuildFailure, findTemplateByName, waitForActive, requireExternalTemplateId } from './platinum-templates';
export { uploadWithRetry } from './platinum-upload';
import type {
  BuildableTemplate,
  BuildLogTap,
  BuildSnapshotResult,
  ProviderState,
  SandboxProviderAdapter,
} from './index';
import { SnapshotInUseError } from './errors';

const MB_PER_GB = 1024;
const BUILD_ATTEMPTS = 3;

// Platinum's POST /v1/templates/from-build hard-caps size_mb at this value (see
// platinum apps/api/src/api/templates.ts ORG_MAX_SIZE_MB + the from-build zod).
// The build ext4 is a FLOOR Platinum grows-to-fit, so clamping the build ceiling
// does NOT shrink the runtime disk (default_disk_gb stays the full spec) — it only
// stops oversize-disk templates from being rejected with a raw "size_mb too_big"
// 400. Single source of truth for the build-size contract; keep in sync w/ Platinum.
export const PLATINUM_MAX_BUILD_SIZE_MB = 20480;
/** Floor for the PLATINUM_BUILD_SIZE_MB knob below — small enough that no real
 *  Kortix image could ever build into anything smaller, so a misconfigured
 *  knob can never clamp the build ceiling into a guaranteed-to-fail range. */
export const PLATINUM_MIN_BUILD_SIZE_MB = 1024;

/**
 * Build-ceiling env knob for `size_mb`, read LAZILY on EVERY call rather than
 * captured once as a module-load const. This module is imported ONCE and
 * shared across the whole `bun test` process (bun's module cache) — a
 * module-load const would freeze whichever suite's env happened to be set
 * first for every OTHER suite in the same run, making a const-based knob
 * untestable. build-context.ts's artifact-path consts document and abolish
 * the exact same anti-pattern for the same reason; this follows suit. Reading
 * `process.env` fresh per call is behaviour-neutral in production, where the
 * env is set once before the process starts.
 *
 * DEPLOY-NEUTRAL: the default is `PLATINUM_MAX_BUILD_SIZE_MB` itself — today's
 * effective ceiling — so shipping this knob changes NOTHING until an operator
 * explicitly sets `PLATINUM_BUILD_SIZE_MB` below the provider cap, after
 * verifying the Platinum build fleet supports grow-to-fit at that size.
 * Clamped to [PLATINUM_MIN_BUILD_SIZE_MB, PLATINUM_MAX_BUILD_SIZE_MB]: never
 * below a floor no real image could build into, never above Platinum's own
 * hard cap. A non-numeric or non-positive value is treated as unset (falls
 * back to the default) rather than producing a broken/zero build ceiling from
 * a typo'd env var.
 */
export function platinumBuildSizeMb(): number {
  const raw = Number(process.env.PLATINUM_BUILD_SIZE_MB);
  if (!Number.isFinite(raw) || raw <= 0) return PLATINUM_MAX_BUILD_SIZE_MB;
  return Math.min(PLATINUM_MAX_BUILD_SIZE_MB, Math.max(PLATINUM_MIN_BUILD_SIZE_MB, raw));
}

/** Distinct, greppable log/error token for the size-cap build-failure class —
 *  lets an operator search logs/Sentry for exactly this failure mode. */
export const PLATINUM_SIZE_CAP_LOG_TOKEN = 'PLATINUM_SIZE_CAP_EXCEEDED';

/**
 * A build ext4 ceiling too small for the image content — wrapped with
 * remediation naming the `PLATINUM_BUILD_SIZE_MB` env knob an operator would
 * raise, plus PLATINUM_SIZE_CAP_LOG_TOKEN, so this failure class is
 * recognizable in logs/Sentry without decoding a raw provider 400 body or an
 * opaque "build failed". NEVER retried (see isRetryablePlatinumBuildError,
 * isPlatinumSizeCapBuildFailure below) — the SAME content at the SAME ceiling
 * fails identically every time, so retrying only burns a BUILD_ATTEMPTS slot.
 */
export class PlatinumSizeCapBuildError extends Error {
  constructor(snapshotName: string, cause: unknown) {
    const causeMsg = cause instanceof Error ? cause.message : String(cause);
    super(
      `${PLATINUM_SIZE_CAP_LOG_TOKEN}: Platinum template ${snapshotName}'s build ext4 ceiling ` +
        `is too small for its image content and can never fit — raise the ` +
        `PLATINUM_BUILD_SIZE_MB env knob (clamped to [${PLATINUM_MIN_BUILD_SIZE_MB}, ` +
        `${PLATINUM_MAX_BUILD_SIZE_MB}]) or shrink the image, then rebuild. Original error: ` +
        `${causeMsg.slice(0, 300)}`,
    );
    this.name = 'PlatinumSizeCapBuildError';
  }
}

/**
 * True iff `err` is Platinum's HOST-SIDE terminal rejection of a build ext4
 * ceiling too small for the image content — either the `from-build`
 * registration's `400 size_mb too_big` (Platinum's from-build zod rejecting a
 * ceiling above its own cap) or an ENOSPC-shaped failure from the async
 * podman build itself outgrowing a ceiling an operator lowered below what the
 * image needs via PLATINUM_BUILD_SIZE_MB (only reachable once that knob is set
 * below today's deploy-neutral default — see platinumBuildSizeMb above). Both
 * are DETERMINISTIC "this size can never fit" failures, never transient.
 */
export function isPlatinumSizeCapBuildFailure(err: unknown): boolean {
  if (err instanceof PlatinumSizeCapBuildError) return true;
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    m.includes(PLATINUM_SIZE_CAP_LOG_TOKEN.toLowerCase()) ||
    m.includes('size_mb too_big') ||
    m.includes('template size cap') ||
    m.includes('enospc') ||
    m.includes('no space left on device')
  );
}

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
 * produced a template (stuck ~15min on `state: missing`, on one dev
 * sandbox), while a fresh build attempt for a
 * different content hash minutes later succeeded on its very first try — so a
 * same-process retry is a real, bounded (BUILD_ATTEMPTS) mitigation, not a
 * blind retry-forever. A build that reaches any OTHER observed state
 * ('building', 'pending', …) before failing is a real failure and still
 * excluded, same as 'failed'.
 */
export function isRetryablePlatinumBuildError(err: unknown): boolean {
  // A build ceiling too small for the image content can never fit — retrying
  // burns a BUILD_ATTEMPTS slot on an outcome that repeats identically. Checked
  // FIRST, ahead of the substring heuristics below, so this class is pinned
  // non-retryable even if a raw ENOSPC/too_big message happens to also contain
  // one of the transient substrings matched below (e.g. "network").
  if (isPlatinumSizeCapBuildFailure(err)) return false;
  // An explicit `state: failed` is a genuine build error. It now carries the
  // build log's failing lines, which can contain any of the transient
  // substrings below ("no such file", "timeout", "network") — so it must be
  // decided before them, by type or (re-wrapped) by its message prefix.
  if (err instanceof PlatinumTemplateBuildFailedError) return false;
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (PLATINUM_BUILD_FAILED_RE.test(m)) return false;
  // Platinum answers 429 for TWO opposite conditions, and only one is transient:
  //   - `rate_limited` (server.ts) — the per-org mutation-rate bucket
  //     (PT_ORG_MUT_RATE, 20 req/s). Transient; retrying is right.
  //   - `org_template_quota_exceeded` (api/templates.ts pickBuildHost) — the
  //     per-org COUNT cap on live templates (tiers 10/50/500). This does NOT
  //     self-clear: nothing frees a template row on its own, and Kortix has no
  //     org-wide GC for Platinum (snapshots/quota-gc.ts is Daytona-only — it
  //     imports listDaytonaSnapshots/deleteDaytonaSnapshotById exclusively). So
  //     burning BUILD_ATTEMPTS on it is pure delay in front of a wall, and it
  //     buries the one error an operator actually needs to see. Fail fast; the
  //     caller falls through to the cold path and the session still boots.
  if (m.includes('org_template_quota_exceeded')) return false;
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

/**
 * kortix.yaml `container_runtime: true` → Platinum `kernel_modules: "container"`
 * on /v1/templates/from-build: the rootfs gets the full guest kernel module
 * tree, so dockerd can use bridge + overlay + netfilter. An API older than the
 * field strips it, and it cannot cancel the build it queued (DELETE answers 409
 * build_in_progress). So a missing echo is a build-log warning, not a failure:
 * the template builds as before, without the modules, and the next identity
 * change (any runtime-layer bump) rebuilds it on the upgraded API.
 */
export function fromBuildKernelModules(input: Pick<BuildableTemplate, 'snapshotName' | 'containerRuntime'>): {
  body: { kernel_modules?: 'container' };
  missing: (registered: PlatinumTemplate) => string | null;
} {
  if (!input.containerRuntime) return { body: {}, missing: () => null };
  return {
    body: { kernel_modules: 'container' },
    missing: (registered) =>
      registered.kernel_modules === 'container'
        ? null
        : `WARNING: Platinum template ${input.snapshotName}: container_runtime was requested, but this ` +
          'Platinum API did not confirm kernel_modules on /v1/templates/from-build. The template builds ' +
          'without the container kernel modules; dockerd will not get bridge networking until Platinum is upgraded.',
  };
}


/** Parallel exact-name lookups per batch when ranking last-ready candidates. */
const NAMED_LOOKUP_CONCURRENCY = 6;

export class PlatinumAdapter implements SandboxProviderAdapter {
  readonly id = 'platinum' as const;

  constructor(private readonly client: PlatinumClient = productionPlatinumClient) {}

  isConfigured(): boolean {
    return this.client.isConfigured();
  }

  async buildSnapshot(input: BuildableTemplate, tap?: BuildLogTap): Promise<BuildSnapshotResult> {
    if (!input.image && !input.userDockerfile) {
      throw new Error('PlatinumAdapter.buildSnapshot: neither image nor userDockerfile set');
    }
    const userDockerfile = input.userDockerfile ?? `FROM ${input.image}\n`;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= BUILD_ATTEMPTS; attempt++) {
      observeTemplates.invalidate();
      try {
        // Return the EXACT external template id the build proved
        // (requireExternalTemplateId inside buildOnce) — threaded to the caller
        // so the transition runner pins THAT id, never a name-list re-derivation.
        const result = await this.buildOnce(input, userDockerfile, tap);
        observeTemplates.invalidate();
        return result;
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
  private async buildOnce(input: BuildableTemplate, userDockerfile: string, tap?: BuildLogTap): Promise<BuildSnapshotResult> {
    // Stage the SAME context Daytona builds (Dockerfile + agent/cli/entrypoint/…).
    const ctx = await stageRuntimeBuildContext({
      snapshotName: input.snapshotName,
      userDockerfile,
      runtimeProfile: input.runtimeProfile,
      appContext: input.appContext,
      isShared: input.isShared,
      containerRuntime: input.containerRuntime,
    });
    const tarPath = join(ctx.contextDir, '..', `${input.snapshotName.replace(/[^a-zA-Z0-9_.-]/g, '_')}.tar.gz`);
    try {
      await tarBuildContext(ctx.contextDir, tarPath);

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
        () => this.client.json<{ upload_url: string; context_s3_key: string }>(
          '/v1/templates/from-build/presign', { method: 'POST', body: JSON.stringify({}) },
        ),
        tarPath,
      );

      const diskGb = Math.min(input.spec.diskGb ?? DEFAULT_DISK_GB, SANDBOX_SPEC_LIMITS.disk.max);
      const kernelModules = fromBuildKernelModules(input);

      const registered = await this.client.json<PlatinumTemplate>('/v1/templates/from-build', {
        method: 'POST',
        body: JSON.stringify({
          name: input.snapshotName,
          context_s3_key,
          dockerfile: ctx.dockerfileName,
          // Build-time ext4 ceiling — DECOUPLED from the runtime disk (default_disk_gb
          // below), which always stays the FULL spec: Platinum grows ext4 to fit, so
          // the artifact consumes only image+headroom (a ~9.4 GiB kortix image builds
          // fine into a 20 GiB ceiling). Three terms, each capping a different thing:
          // platinumBuildSizeMb() is the operator-tunable knob (env
          // PLATINUM_BUILD_SIZE_MB, default = PLATINUM_MAX_BUILD_SIZE_MB — i.e.
          // deploy-neutral until an operator explicitly lowers it); diskGb * MB_PER_GB
          // keeps a small-disk template's ceiling no larger than it needs; PLATINUM_
          // MAX_BUILD_SIZE_MB is Platinum's own from-build hard cap (>20 GiB-disk
          // without it 400s "size_mb too_big"). See isPlatinumSizeCapBuildFailure for
          // what happens when a ceiling this small can't fit the image.
          size_mb: Math.min(platinumBuildSizeMb(), diskGb * MB_PER_GB, PLATINUM_MAX_BUILD_SIZE_MB),
          default_cpu: input.spec.cpu ?? DEFAULT_CPU,
          default_ram_mb: (input.spec.memoryGb ?? DEFAULT_MEMORY_GB) * 1024,
          default_disk_gb: diskGb,
          entrypoint: (input.entrypoint ?? [KORTIX_ENTRYPOINT]).join(' '),
          ...kernelModules.body,
        }),
      });
      // PHASE 2 EXACT ID: from-build MUST hand back a non-empty template id. We
      // poll THAT id (never the truncated name list) — see waitForActive.
      const externalId = requireExternalTemplateId(registered?.id, `from-build for ${input.snapshotName}`);
      const kernelModulesWarning = kernelModules.missing(registered);
      if (kernelModulesWarning) {
        console.warn(`[snapshots] ${kernelModulesWarning}`);
        tap?.onLine?.(kernelModulesWarning);
      }
      await waitForActive(input.snapshotName, tap, externalId, this.client);
      // FIX-B: hand the EXACT proven id back to the caller (ppwarm → transition
      // runner) — no name-list re-derivation downstream.
      return { externalTemplateId: externalId };
    } catch (err) {
      // A too-small build ceiling is a DETERMINISTIC "this size can never fit"
      // failure — wrap it with remediation (naming PLATINUM_BUILD_SIZE_MB) and
      // the greppable log token BEFORE buildSnapshot's retry loop above sees it
      // via isRetryablePlatinumBuildError, so it's recognizable in logs without
      // decoding a raw provider 400 / opaque "build failed". Every other error
      // passes through unchanged.
      throw isPlatinumSizeCapBuildFailure(err) ? new PlatinumSizeCapBuildError(input.snapshotName, err) : err;
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
  async swapAgent(newSnapshotName: string, sourceSnapshotName: string): Promise<BuildSnapshotResult> {
    observeTemplates.invalidate();
    const { gzPath, cleanup } = await stageAgentBinaryGz();
    try {
      // uploadWithRetry — streamed + retried on transient S3 failure; see buildOnce.
      const context_s3_key = await uploadWithRetry(
        () => this.client.json<{ upload_url: string; context_s3_key: string }>(
          '/v1/templates/from-build/presign', { method: 'POST', body: JSON.stringify({}) },
        ),
        gzPath,
      );
      // Platinum's GENERAL file-patch primitive: patch our one changed file (the
      // kortix-agent binary) into the predecessor's rootfs — no rebuild. The guest
      // path is OURS to specify (Platinum is file-agnostic); /usr/local/bin/kortix-agent
      // is where our runtime layer (dockerfile-layer.ts) installs it. mode 0100755 =
      // executable (debugfs `write` lands 0644 otherwise).
      const patched = await this.client.json<PlatinumTemplate>('/v1/templates/from-patch', {
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
      await waitForActive(newSnapshotName, undefined, externalId, this.client);
      // FIX-B: return the exact patched-template id (same contract as buildSnapshot).
      return { externalTemplateId: externalId };
    } finally {
      observeTemplates.invalidate();
      await cleanup();
    }
  }

  async getSnapshotState(snapshotName: string): Promise<ProviderState> {
    if (!this.client.isConfigured()) return 'missing';
    try {
      const template = await findTemplateByName(snapshotName, this.client);
      return template ? normalizeExistingProviderState(template.state) : 'missing';
    } catch (err) {
      // See isPlatinumAuthFailure's doc comment: a dead/revoked key must
      // propagate so callers (the provider-migration workflow) classify it as
      // PERMANENT, not silently degrade to 'unknown' → indeterminate → retry.
      if (isPlatinumAuthFailure(err)) throw err;
      return 'unknown';
    }
  }

  async findFirstActiveSnapshot(names: readonly string[]): Promise<string | null> {
    if (!this.client.isConfigured() || names.length === 0) return null;
    // Exact-name lookups: one request per candidate instead of a walk of the
    // whole org list (34 pages on Kortix Dev, 2026-10-02). The first candidate
    // doubles as the probe for the control plane's `?name=` filter.
    const isActive = (rows: PlatinumTemplate[]) =>
      rows.some((t) => normalizeExistingProviderState(t.state) === 'active');
    const [firstName, ...rest] = names;
    if (firstName === undefined) return null;
    const first = await lookupTemplatesNamed(firstName, this.client);
    if ('named' in first) {
      if (isActive(first.named)) return firstName;
      for (let i = 0; i < rest.length; i += NAMED_LOOKUP_CONCURRENCY) {
        const batch = rest.slice(i, i + NAMED_LOOKUP_CONCURRENCY);
        const results = await Promise.all(
          batch.map((name) =>
            lookupTemplatesNamed(name, this.client).then((result) => ({ name, result })),
          ),
        );
        // Results keep batch order, so the first hit is the highest-priority one.
        const hit = results.find(({ result }) => 'named' in result && isActive(result.named));
        if (hit) return hit.name;
      }
      return null;
    }
    const priorities = new Map(names.map((name, index) => [name, index]));
    let bestIndex: number | null = null;
    const { early } = await paginateTemplates<string>(
      (page) => {
        for (const template of page) {
          const index = template.name ? priorities.get(template.name) : undefined;
          if (
            index !== undefined &&
            normalizeExistingProviderState(template.state) === 'active' &&
            (bestIndex === null || index < bestIndex)
          ) {
            bestIndex = index;
          }
        }
        // No later page can improve on the caller's first candidate.
        return bestIndex === 0 ? names[0] : undefined;
      },
      this.client,
      first.firstPage,
    );
    return early ?? (bestIndex === null ? null : names[bestIndex]!);
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
    if (!this.client.isConfigured()) return null;
    try {
      const template = await findTemplateByName(snapshotName, this.client);
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
    if (!this.client.isConfigured()) return 'missing';
    if (!externalId || externalId.trim() === '') return 'missing';
    try {
      const template = await findTemplateById(externalId, this.client);
      return template ? normalizeExistingProviderState(template.state) : 'missing';
    } catch (err) {
      if (isPlatinumAuthFailure(err)) throw err;
      return 'unknown';
    }
  }

  async deleteSnapshot(snapshotName: string): Promise<void> {
    if (!this.client.isConfigured()) return;
    observeTemplates.invalidate();
    try {
      // One exact-name request, not a walk of every template in the org: this
      // runs on the first session after a deploy (reaping the predecessor).
      const lookup = await lookupTemplatesNamed(snapshotName, this.client);
      const matches =
        'named' in lookup
          ? lookup.named
          : (await paginateTemplates(() => undefined, this.client, lookup.firstPage)).all.filter(
              (template) => template.name === snapshotName,
            );
      let inUse = 0;
      for (const template of matches) {
        try {
          await this.client.json(`/v1/templates/${template.id}`, { method: 'DELETE' });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // A lookup/delete race is equivalent to already gone.
          if (/ -> 404(?:\s|$)/.test(message)) continue;
          // Platinum refuses while sandboxes still pin the rootfs. Keep deleting
          // free duplicates, then report the refusal as a typed error.
          const pinned = templateInUseCount(message);
          if (pinned !== null) {
            inUse += pinned;
            continue;
          }
          // Provider outages must propagate so fan-out reports this provider as failed.
          throw err;
        }
      }
      if (inUse > 0) throw new SnapshotInUseError(snapshotName, inUse);
    } finally {
      observeTemplates.invalidate();
    }
  }

  async listSnapshots(): Promise<Array<{ name: string }>> {
    if (!this.client.isConfigured()) return [];
    // FIX-C: walk the FULL paginated list — the reaper needs every superseded
    // ppwarm image, not just the first 50 (created_at DESC), or an older tip past
    // page 1 lingers forever. A listing FAILURE throws (never returns a truncated
    // list the caller would mistake for "these are all the templates").
    return (await fetchAllTemplates(this.client))
      .map((template) => template.name)
      .filter((name): name is string => !!name)
      .map((name) => ({ name }));
  }
}

export const platinumProvider = new PlatinumAdapter();

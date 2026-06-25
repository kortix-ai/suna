/**
 * Warm sandbox pre-warm — API driver for the daemon's KORTIX_WARM_POOL mode.
 *
 * FAIL-SAFE OFF by default: the DB-backed warm_pool setting is the master gate.
 * When it is off, every exported entry point is inert: the allocator skips the
 * claim path, every create cold-provisions byte-identically to today, and
 * reconcile only reaps stray pool rows. When operators enable the gate, each
 * sandbox template still has to opt in separately. There is no global cap —
 * cost is bounded per-account (billing gate), per-template (size), by
 * presence-reap, and by the provider's autoStop clamp.
 *
 * Design (decoupled from the durable session id — unlike the retired pool):
 *   - spawnSpare:  provision a SESSION-LESS box with env KORTIX_WARM_POOL=1 so the
 *                  daemon boots runPoolMode (opencode + proxy up, parked). The
 *                  row's sandbox_id is a throwaway SPARE uuid (NOT a session id).
 *   - claim:       createProjectSession owns the session id; the allocator calls
 *                  claimSpareForSession, which atomically grabs a parked spare,
 *                  stages the session env into the box (/tmp/pt-env via the
 *                  daemon /file/upload — the daemon's env-poll then clones +
 *                  warms), and BINDS a fresh session_sandboxes row keyed
 *                  sandbox_id == session_id at the spare's external_id.
 *   - any miss/error ⇒ return null ⇒ allocator cold-falls-back unchanged.
 *
 * The box keeps its PARK-time KORTIX_TOKEN (the claim env deliberately omits it),
 * so the claimed row's config.serviceKey MUST stay the park key — the proxy
 * authenticates upstream with it.
 */
import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';

import { kortixApiKeys, projects, projectSessions, sessionSandboxes, warmPoolPresence } from '@kortix/db';
import { config, type SandboxProviderName } from '../../config';
import { db } from '../../shared/db';
import { getProvider } from '../providers';
import { selectProvider } from './provider-balancer';
import { createApiKey } from '../../repositories/api-keys';
import { createAccountToken } from '../../repositories/account-tokens';
import { resolveAgentGrant } from '../../projects/agents';
import { ensureAgentServiceAccount } from '../../repositories/service-accounts';
import type { GitBackedProject } from '../../projects/git';
import { accountEntitledToLlmGateway } from '../../shared/account-limits';
import { checkBillingActive } from '../../billing/services/billing-gate';
import { ensureSandboxImage, DEFAULT_SANDBOX_SLUG } from '../../snapshots/builder';
import { warmPoolSetting } from './runtime-settings';
import { buildSpareSandboxEnvVars } from '../../projects/lib/sessions';
import { resolvePreviewLink } from '../../sandbox-proxy/backend';
import { resolvePreviewUserContext } from '../../shared/preview-ownership';
import { encodeKortixUserContext, KORTIX_USER_CONTEXT_HEADER } from '../../shared/kortix-user-context';
import { randomUUID } from 'node:crypto';

const POOL_BOOT_TIMEOUT_MS = 8 * 60 * 1000; // booting/parked longer than this → reap
const POOL_MAX_AGE_MS = 6 * 60 * 60 * 1000; // parked longer than this → cycle (snapshot drift)
const CLAIM_STALE_MS = 5 * 60 * 1000; // a 'claiming' row older than this → the claimant died → reap (>> a normal claim's <15s, so reconcile never races a live claim)
const READY_PROBE_INTERVAL_MS = 2000;
const MAX_WARM_SIZE = 25;
const PT_ENV_PATH = '/tmp/pt-env'; // MUST match the daemon (main.ts reloadSessionEnv + poll)
const DAEMON_PORT = 8000;

export interface WarmPoolConfig {
  enabled: boolean;
  size: number;
}

/** Master gate. Default OFF — we don't run warm pools by default. The live
 *  value is the DB `warm_pool` setting (admin Providers panel), not env, so an
 *  operator flips it without a redeploy. When OFF the whole driver is inert
 *  (claim path skipped, every create cold-provisions) and every per-template
 *  opt-in is AND-gated to off. NOT tied to the optional global cap. */
export const warmPoolEnabled = (): boolean => warmPoolSetting().enabled;

/**
 * Per-template warm config, read from `projects.metadata.warm_pool_templates[slug]`.
 * OPT-IN: `enabled` is true only when the operator gate is on AND this template's
 * slug was explicitly turned on (UI). Size defaults to the DB warm_pool size.
 *
 * The old project-wide opt-OUT `warm_pool` field is intentionally ignored — warm
 * pool is now off by default and configured per sandbox template, so any project
 * that was auto-warming under the old default goes cold until a template is
 * explicitly opted in.
 */
export function resolveTemplateWarmConfig(metadata: unknown, slug: string): WarmPoolConfig {
  const map = (metadata as Record<string, unknown> | null | undefined)?.warm_pool_templates;
  const raw =
    map && typeof map === 'object' && !Array.isArray(map)
      ? (map as Record<string, unknown>)[slug]
      : undefined;
  const cfg = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  const optedIn = cfg?.enabled === true;
  const size =
    cfg && typeof cfg.size === 'number' && Number.isInteger(cfg.size) && cfg.size >= 0
      ? Math.min(cfg.size, MAX_WARM_SIZE)
      : warmPoolSetting().size;
  return { enabled: warmPoolEnabled() && optedIn, size };
}

/** Every slug a project has warm config for, with its resolved (gated) config. */
export function listProjectWarmTemplates(metadata: unknown): Array<{ slug: string } & WarmPoolConfig> {
  const map = (metadata as Record<string, unknown> | null | undefined)?.warm_pool_templates;
  if (!map || typeof map !== 'object' || Array.isArray(map)) return [];
  return Object.keys(map as Record<string, unknown>).map((slug) => ({
    slug,
    ...resolveTemplateWarmConfig(metadata, slug),
  }));
}

/** Back-compat shim: the project's DEFAULT-template warm config. */
export function resolveWarmConfig(metadata: unknown): WarmPoolConfig {
  return resolveTemplateWarmConfig(metadata, DEFAULT_SANDBOX_SLUG);
}

/** Why a pool row should be reaped, or null to keep it. Pure (unit-testable). */
export function warmBoxReapReason(
  row: { poolState: string | null; status: string; createdAt: Date; updatedAt: Date },
  now: number,
  opts: { bootTimeoutMs?: number; maxAgeMs?: number; claimStaleMs?: number } = {},
): string | null {
  const bootTimeoutMs = opts.bootTimeoutMs ?? POOL_BOOT_TIMEOUT_MS;
  const maxAgeMs = opts.maxAgeMs ?? POOL_MAX_AGE_MS;
  const claimStaleMs = opts.claimStaleMs ?? CLAIM_STALE_MS;
  if (row.poolState === 'reap') return 'marked';
  if (row.status === 'error') return 'errored';
  if (row.poolState === 'booting' && now - row.createdAt.getTime() > bootTimeoutMs) return 'boot-timeout';
  if (row.poolState === 'claiming' && now - row.updatedAt.getTime() > claimStaleMs) return 'claim-timeout';
  if (row.poolState === 'parked' && now - row.createdAt.getTime() > maxAgeMs) return 'aged-out';
  return null;
}

/** Live counts for a project: `ready` (parked, claimable) + `warming` (booting). */
export async function getWarmPoolCounts(projectId: string): Promise<{ ready: number; warming: number }> {
  const rows = await db
    .select({ poolState: sessionSandboxes.poolState, n: sql<number>`count(*)::int` })
    .from(sessionSandboxes)
    .where(and(eq(sessionSandboxes.projectId, projectId), inArray(sessionSandboxes.poolState, ['parked', 'booting'])))
    .groupBy(sessionSandboxes.poolState);
  let ready = 0;
  let warming = 0;
  for (const r of rows) {
    if (r.poolState === 'parked') ready = Number(r.n);
    else if (r.poolState === 'booting') warming = Number(r.n);
  }
  return { ready, warming };
}

/** Per-slug live counts for a project: slug → { ready (parked), warming (booting) }.
 *  Spares are tagged with `metadata.warmSpareSlug` at spawn; older untagged spares
 *  fall back to the default slug (they were always built from the default image). */
export async function getWarmCountsBySlug(
  projectId: string,
): Promise<Map<string, { ready: number; warming: number }>> {
  const res = await db.execute(sql`
    SELECT COALESCE(metadata->>'warmSpareSlug', ${DEFAULT_SANDBOX_SLUG}) AS slug, pool_state, count(*)::int AS n
    FROM kortix.session_sandboxes
    WHERE project_id = ${projectId} AND pool_state IN ('parked', 'booting')
    GROUP BY 1, 2
  `);
  const rows = ((res as unknown as { rows?: any[] }).rows ?? (res as unknown as any[])) as Array<{
    slug: string;
    pool_state: string;
    n: number;
  }>;
  const out = new Map<string, { ready: number; warming: number }>();
  for (const r of rows) {
    const cur = out.get(r.slug) ?? { ready: 0, warming: 0 };
    if (r.pool_state === 'parked') cur.ready = Number(r.n);
    else if (r.pool_state === 'booting') cur.warming = Number(r.n);
    out.set(r.slug, cur);
  }
  return out;
}

async function reapWarmSandbox(row: { sandboxId: string; externalId: string | null; provider: string }): Promise<void> {
  try {
    if (row.externalId) await getProvider(row.provider as any).remove(row.externalId);
  } catch (err) {
    console.warn(`[warm-pool] provider remove failed for ${row.sandboxId.slice(0, 8)}:`, err instanceof Error ? err.message : err);
  }
  await db.delete(sessionSandboxes).where(eq(sessionSandboxes.sandboxId, row.sandboxId)).catch(() => {});
}

// ── Spare provisioning ───────────────────────────────────────────────────────

/** Provision one session-less spare for a project + sandbox template `slug`
 *  (boots the daemon's pool mode). The spare is tagged with `warmSpareSlug` so a
 *  claim only binds it to a session that asked for the SAME template. */
async function spawnSpare(project: {
  projectId: string;
  accountId: string;
  repoUrl: string | null;
  defaultBranch: string;
  manifestPath: string | null;
  metadata?: unknown;
}, slug: string, gitAuthToken: string | null): Promise<void> {
  if (!project.repoUrl) return;
  const spareId = randomUUID();
  const provider = await selectProvider();
  try {
    // The spare's KORTIX_TOKEN (the box stays authenticated with this through the
    // claim — the claim env never overwrites it), persisted as config.serviceKey
    // so the proxy + the claim-write can authenticate to the box.
    const sandboxKey = await createApiKey({ sandboxId: spareId, accountId: project.accountId, title: 'Warm Spare Token', type: 'sandbox' });

    await db.insert(sessionSandboxes).values({
      sandboxId: spareId,
      sessionId: spareId, // sentinel — satisfies NOT NULL/UNIQUE; the real session id is bound at claim
      accountId: project.accountId,
      projectId: project.projectId,
      provider,
      externalId: null,
      status: 'provisioning',
      poolState: 'booting',
      baseUrl: null,
      config: { serviceKey: sandboxKey.secretKey },
      metadata: { warmSpare: true, warmSpareSlug: slug },
    });

    // Boot the project's normal Dockerfile snapshot (NOT the experimental warm
    // base) so the box's env survives in process.env for the daemon to read.
    const image = await ensureSandboxImage(
      { projectId: project.projectId, repoUrl: project.repoUrl, defaultBranch: project.defaultBranch, manifestPath: project.manifestPath ?? '', gitAuthToken },
      { slug, accountId: project.accountId, source: 'background', provider },
    );

    // Stage-2: hand the spare its project identity (repo, no session) + the
    // clone-at-park flag so the daemon clones the base branch + warms the
    // opencode project plugin while parked. KORTIX_TOKEN stays the spare's park
    // key (last, never clobbered by the project env). Without the flag the spare
    // is a generic Stage-1 box that clones + warms on claim.
    const parkEnv = config.KORTIX_WARM_POOL_CLONE_AT_PARK
      ? {
          ...buildSpareSandboxEnvVars({
            projectId: project.projectId,
            repoUrl: project.repoUrl,
            baseRef: project.defaultBranch,
            agentName: 'default',
          }),
          KORTIX_WARM_POOL_CLONE_AT_PARK: '1',
        }
      : {};

    const result = await getProvider(provider).create({
      accountId: project.accountId,
      userId: '',
      name: `warm-${spareId.slice(0, 8)}`,
      envVars: { ...parkEnv, KORTIX_WARM_POOL: '1', KORTIX_TOKEN: sandboxKey.secretKey },
      snapshot: image.snapshotName,
      autoStopInterval: 0, // stay up until claimed/reaped
    });

    await db
      .update(sessionSandboxes)
      .set({ externalId: result.externalId, baseUrl: result.baseUrl || null, updatedAt: new Date() })
      .where(eq(sessionSandboxes.sandboxId, spareId));

    // Stage-2 spares must be RUNTIME-ready (repo cloned + opencode warm) before
    // they're claimable — a park-clone failure leaves opencode on the default
    // config, so gate on runtimeReady so such a spare is reaped (boot-timeout) +
    // replaced rather than serving a claim with the wrong opencode config.
    void promoteSpareWhenReady(spareId, result.externalId, config.KORTIX_WARM_POOL_CLONE_AT_PARK).catch(() => {});
    console.log(`[warm-pool] spawned spare ${spareId.slice(0, 8)} for project ${project.projectId.slice(0, 8)}`);
  } catch (err) {
    console.warn(`[warm-pool] spawn spare ${spareId.slice(0, 8)} failed:`, err instanceof Error ? err.message : err);
    await db.update(sessionSandboxes).set({ status: 'error', updatedAt: new Date() }).where(eq(sessionSandboxes.sandboxId, spareId)).catch(() => {});
  }
}

/** Background: poll the spare's daemon until its pool runtime is up, then park it.
 *  requireRuntimeReady (Stage-2 clone-at-park): only park once the daemon reports
 *  runtimeReady — i.e. repo cloned + opencode warmed against the PROJECT config.
 *  A park-clone failure never flips runtimeReady, so the spare boot-times-out and
 *  is reaped instead of parking with opencode stuck on the default config. */
async function promoteSpareWhenReady(spareId: string, externalId: string, requireRuntimeReady = false): Promise<void> {
  const deadline = Date.now() + POOL_BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, READY_PROBE_INTERVAL_MS));
    const [row] = await db
      .select({ poolState: sessionSandboxes.poolState, status: sessionSandboxes.status })
      .from(sessionSandboxes)
      .where(eq(sessionSandboxes.sandboxId, spareId))
      .limit(1);
    if (!row || row.poolState !== 'booting') return; // claimed/reaped/gone elsewhere
    if (row.status === 'error') return;
    // /kortix/health bypasses the daemon AUTH gate, so it answers before claim —
    // but Daytona's preview PROXY still gates on the per-link preview token, so a
    // tokenless fetch gets HTTP 400 and never sees the daemon. Send the preview
    // token + skip-warning header (same as buildSandboxUpstreamHeaders) or the
    // probe always fails and the spare never parks.
    let healthy = false;
    try {
      const { url, token } = await resolvePreviewLink(externalId, DAEMON_PORT);
      const headers: Record<string, string> = { 'X-Daytona-Skip-Preview-Warning': 'true' };
      if (token) headers['X-Daytona-Preview-Token'] = token;
      const r = await fetch(`${url.replace(/\/$/, '')}/kortix/health`, { headers, signal: AbortSignal.timeout(8_000) });
      if (requireRuntimeReady) {
        const body = r.ok ? ((await r.json().catch(() => null)) as { runtimeReady?: boolean } | null) : null;
        healthy = body?.runtimeReady === true;
      } else {
        healthy = r.ok;
      }
    } catch {
      healthy = false;
    }
    if (healthy) {
      await db.update(sessionSandboxes).set({ poolState: 'parked', lastUsedAt: new Date(), updatedAt: new Date() }).where(eq(sessionSandboxes.sandboxId, spareId));
      console.log(`[warm-pool] parked spare ${spareId.slice(0, 8)}`);
      return;
    }
  }
  console.warn(`[warm-pool] spare ${spareId.slice(0, 8)} never became ready → leaving for boot-timeout reap`);
}

// ── Claim ────────────────────────────────────────────────────────────────────

interface ClaimedSpare {
  spareSandboxId: string;
  externalId: string;
  baseUrl: string | null;
  serviceKey: string; // the PARK key — stays the claimed row's serviceKey
}

/** Atomically take one parked spare for the project + template `slug` (flip
 *  parked→claiming). Single statement + SKIP LOCKED so concurrent creates never
 *  grab the same spare. The slug match guarantees a session only ever binds a
 *  spare built from the SAME sandbox template (else a custom-template session
 *  could claim a default-image spare). */
async function claimSpare(projectId: string, slug: string): Promise<ClaimedSpare | null> {
  const res = await db.execute(sql`
    UPDATE kortix.session_sandboxes
    SET pool_state = 'claiming', updated_at = now()
    WHERE sandbox_id = (
      SELECT s.sandbox_id FROM kortix.session_sandboxes s
      WHERE s.project_id = ${projectId}
        AND s.pool_state = 'parked'
        AND COALESCE(s.metadata->>'warmSpareSlug', ${DEFAULT_SANDBOX_SLUG}) = ${slug}
        -- A parked spare's box has finished provisioning, so its status is
        -- 'active' (the box-ready finish in session-sandbox.ts sets it); it is
        -- 'provisioning' only in the brief window before that finish lands. The
        -- old 'provisioning'-only filter never matched a parked spare, so EVERY
        -- claim missed and fell back to a cold create — the pool never worked.
        -- Accept both healthy states; pool_state='parked' already scopes to
        -- session-less spares, and error/failed/stopped are excluded.
        AND s.status IN ('active', 'provisioning')
        AND s.external_id IS NOT NULL
      ORDER BY s.created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING sandbox_id, external_id, base_url, config
  `);
  const rows = (res as unknown as { rows?: any[] }).rows ?? (res as unknown as any[]);
  const row = Array.isArray(rows) ? rows[0] : undefined;
  if (!row) return null;
  const serviceKey = ((row.config ?? {}) as Record<string, unknown>).serviceKey;
  if (typeof serviceKey !== 'string') return null;
  return { spareSandboxId: row.sandbox_id as string, externalId: row.external_id as string, baseUrl: (row.base_url ?? null) as string | null, serviceKey };
}

/** Release a claimed spare: back to 'parked' (still healthy) or 'reap' (dead). */
async function releaseSpare(spareSandboxId: string, to: 'parked' | 'reap'): Promise<void> {
  await db.update(sessionSandboxes).set({ poolState: to, updatedAt: new Date() }).where(eq(sessionSandboxes.sandboxId, spareSandboxId)).catch(() => {});
}

/** Stage the session env into the spare box's /tmp/pt-env via the daemon's
 *  /file/upload (field-name-as-path). The daemon's env-poll then adopts the
 *  session (clone + opencode warm). Returns false on any failure → cold fallback. */
async function stageClaimEnv(externalId: string, serviceKey: string, userId: string, envVars: Record<string, string>): Promise<boolean> {
  // reloadSessionEnv is line-split with no unquoting — a value containing a
  // newline would corrupt the file. Reject rather than write a torn env.
  for (const v of Object.values(envVars)) {
    if (v.includes('\n') || v.includes('\r')) {
      console.warn('[warm-pool] claim env has a newline value — falling back to cold');
      return false;
    }
  }
  // KORTIX_API_URL is the daemon's poll sentinel (/^KORTIX_API_URL=\S/m) — write
  // it LAST so the file is only "armed" once every other key has landed.
  const sandboxApiBase = config.KORTIX_URL.replace(/\/+$/, '').replace(/\/v1\/router$/, '').replace(/\/v1$/, '');
  const ordered: [string, string][] = [];
  for (const [k, v] of Object.entries(envVars)) {
    if (k === 'KORTIX_API_URL' || k === 'KORTIX_TOKEN') continue; // token stays the park key; api url written last
    ordered.push([k, v]);
  }
  ordered.push(['KORTIX_API_URL', `${sandboxApiBase}/v1`]);
  const body = ordered.map(([k, v]) => `${k}=${v}`).join('\n') + '\n';

  try {
    const { url, token } = await resolvePreviewLink(externalId, DAEMON_PORT);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${serviceKey}`,
      'X-Daytona-Skip-Preview-Warning': 'true',
      'X-Daytona-Disable-CORS': 'true',
    };
    if (token) headers['X-Daytona-Preview-Token'] = token;
    const payload = await resolvePreviewUserContext(externalId, userId);
    if (payload) headers[KORTIX_USER_CONTEXT_HEADER] = encodeKortixUserContext(payload, serviceKey);

    const form = new FormData();
    // field NAME is the destination path (files.ts field-name-as-path convention).
    form.append(PT_ENV_PATH, new Blob([body], { type: 'text/plain' }), 'pt-env');
    const res = await fetch(`${url.replace(/\/$/, '')}/file/upload`, { method: 'POST', headers, body: form, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      console.warn(`[warm-pool] claim env stage → ${res.status}`);
      return false;
    }
    // writeUploadUnique never overwrites: a collision lands at a SUFFIXED path the
    // daemon never reads. Confirm the bytes landed exactly at PT_ENV_PATH.
    const out = (await res.json().catch(() => null)) as Array<{ path?: string }> | null;
    const landed = Array.isArray(out) && out.some((r) => r?.path === PT_ENV_PATH);
    if (!landed) {
      console.warn('[warm-pool] claim env did not land at the expected path (collision?) — cold fallback');
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[warm-pool] claim env stage failed:', err instanceof Error ? err.message : err);
    return false;
  }
}

/** Bind a claimed spare to the real session: insert the session_sandboxes row
 *  (sandbox_id == session_id) at the spare's external_id, delete the spare row. */
async function bindClaimedSpare(input: {
  spare: ClaimedSpare;
  sessionId: string;
  accountId: string;
  projectId: string;
  provider: SandboxProviderName;
  sessionMetadata: Record<string, unknown>;
}): Promise<boolean> {
  // The session may have been deleted mid-claim — don't bind a doomed session.
  const [session] = await db.select({ status: projectSessions.status }).from(projectSessions).where(eq(projectSessions.sessionId, input.sessionId)).limit(1);
  if (!session || session.status === 'stopped' || session.status === 'failed') {
    await releaseSpare(input.spare.spareSandboxId, 'parked');
    return false;
  }
  try {
    // ATOMIC: insert the session row, re-scope the spare's sandbox token to that
    // session row, then delete the spare row in ONE tx. Both rows share the same
    // external_id; if the spare row lingered (insert ok, delete failed) a later
    // claim-timeout reap would provider.remove() the box out from under the
    // now-bound session. The tx makes "bound" ⇒ "spare row gone".
    //
    // The box keeps the same KORTIX_TOKEN bytes it received while parked. Git
    // proxy auth resolves those bytes via api_keys.sandbox_id, then requires a
    // live session_sandboxes row for that sandbox id. If we delete the spare row
    // without moving the api_key scope, post-claim clones/fetches fail with
    // "sandbox token is not scoped to this project". Re-scope before the delete
    // so old-token bytes authenticate as the real session id after commit.
    // The delete is GUARDED on poolState='claiming': if reconcileWarmPool reaped
    // the spare row mid-claim (claim outran CLAIM_STALE_MS), the guard deletes 0
    // rows → we throw → the whole bind rolls back → cold fallback, so we never
    // leave a session row pointing at a box the reaper may have removed.
    await db.transaction(async (tx) => {
      await tx.insert(sessionSandboxes).values({
        sandboxId: input.sessionId, // sandbox_id == session_id (the invariant the proxy/pin/hibernation rely on)
        sessionId: input.sessionId,
        accountId: input.accountId,
        projectId: input.projectId,
        provider: input.provider,
        externalId: input.spare.externalId,
        baseUrl: input.spare.baseUrl,
        // 'active': the box already exists + its daemon is up; the FE's opencode
        // readiness poll waits out the post-claim clone+warm (same as a cold box
        // mid-boot). poolState NULL re-enables idle hibernation (maintenance only
        // hibernates poolState IS NULL).
        status: 'active',
        poolState: null,
        config: { serviceKey: input.spare.serviceKey }, // PARK key — the box keeps authenticating with it
        metadata: { ...input.sessionMetadata, claimed_from_spare: input.spare.spareSandboxId },
        lastUsedAt: new Date(),
      });
      const movedKeys = await tx
        .update(kortixApiKeys)
        .set({ sandboxId: input.sessionId })
        .where(and(
          eq(kortixApiKeys.sandboxId, input.spare.spareSandboxId),
          eq(kortixApiKeys.accountId, input.accountId),
          eq(kortixApiKeys.type, 'sandbox'),
          eq(kortixApiKeys.status, 'active'),
        ))
        .returning({ id: kortixApiKeys.keyId });
      if (movedKeys.length === 0) {
        throw new Error('spare sandbox token missing — rolling back bind');
      }
      const removed = await tx
        .delete(sessionSandboxes)
        .where(and(eq(sessionSandboxes.sandboxId, input.spare.spareSandboxId), eq(sessionSandboxes.poolState, 'claiming')))
        .returning({ id: sessionSandboxes.sandboxId });
      if (removed.length === 0) {
        throw new Error('spare row no longer claiming (reaped mid-claim) — rolling back bind');
      }
    });
    await db.update(projectSessions).set({ status: 'running', sandboxUrl: input.spare.baseUrl ?? null, updatedAt: new Date() }).where(eq(projectSessions.sessionId, input.sessionId)).catch(() => {});
    return true;
  } catch (err) {
    console.warn(`[warm-pool] bind spare → session ${input.sessionId.slice(0, 8)} failed:`, err instanceof Error ? err.message : err);
    await releaseSpare(input.spare.spareSandboxId, 'parked').catch(() => {});
    return false;
  }
}

export interface ClaimSpareForSessionInput {
  sessionId: string;
  accountId: string;
  projectId: string;
  userId: string;
  provider: SandboxProviderName;
  /** Sandbox template the session asked for. Only a spare built from the SAME
   *  template is claimable; defaults to the platform default template. */
  slug?: string;
  /** The exact env the cold path would inject (buildSessionSandboxEnvVars output). */
  builtEnvVars: Record<string, string>;
  sessionMetadata: Record<string, unknown>;
  /** Agent the session runs as + the project's git context, so the warm path
   *  resolves and stamps the SAME AgentGrant the cold path does. Without these
   *  the minted executor token carried no grant → full bypass of kortix_cli +
   *  connector scoping on every warm-served session. */
  agentName: string;
  gitProject: GitBackedProject;
}

/**
 * THE single entry the allocator calls. Returns { externalId } on a successful
 * warm claim, or null on any miss/error (⇒ cold fallback). Never throws.
 */
export async function claimSpareForSession(input: ClaimSpareForSessionInput): Promise<{ externalId: string } | null> {
  if (!warmPoolEnabled()) return null;
  const slug = (input.slug ?? '').trim() || DEFAULT_SANDBOX_SLUG;
  let spare: ClaimedSpare | null = null;
  // Resolve the agent grant IN PARALLEL with the spare claim so it adds no
  // latency to the warm fast-path. Failure → null (same posture as the cold path
  // in session-sandbox.ts).
  const grantPromise = resolveAgentGrant(input.agentName, input.gitProject).catch((err) => {
    console.warn('[warm-pool] failed to resolve agent grant:', err instanceof Error ? err.message : err);
    return null;
  });
  // Standing identity, IN PARALLEL with the claim too. Fail-safe → null = legacy
  // (authorize as user ∩ grant); never widens, so a hiccup can't break the warm
  // start. MUST be set here as well or warm-served sessions silently lose the
  // agent identity (the same trap the AgentGrant comment below flags).
  const saPromise = ensureAgentServiceAccount({
    accountId: input.accountId,
    projectId: input.projectId,
    agentName: input.agentName,
  }).catch((err) => {
    console.warn('[warm-pool] failed to ensure agent service account:', err instanceof Error ? err.message : err);
    return null;
  });
  try {
    spare = await claimSpare(input.projectId, slug);
    if (!spare) return null;

    // Per-session executor/LLM tokens — delivered via the claim env file and read
    // fresh by the daemon's loadConfig on reload (NOT the sandbox KORTIX_TOKEN,
    // which stays the spare's park key). The token MUST carry the AgentGrant or
    // the warm path silently bypasses all kortix_cli + connector scoping.
    let executorToken: string | null = null;
    try {
      const [agentGrant, serviceAccountId] = await Promise.all([grantPromise, saPromise]);
      executorToken = (await createAccountToken({ accountId: input.accountId, userId: input.userId, projectId: input.projectId, name: `Executor Session ${input.sessionId.slice(0, 8)}`, agentGrant, serviceAccountId })).secretKey;
    } catch (err) {
      console.warn('[warm-pool] executor token mint failed:', err instanceof Error ? err.message : err);
    }
    const gatewayEntitled = config.LLM_GATEWAY_ENABLED ? await accountEntitledToLlmGateway(input.accountId).catch(() => false) : false;
    const gatewayLlmKey = config.LLM_GATEWAY_ENABLED && gatewayEntitled ? executorToken : null;
    const kortixOrigin = config.KORTIX_URL.replace(/\/+$/, '');
    const llmProxyMode = config.LLM_GATEWAY_PROXY_PORT || config.LLM_GATEWAY_PROXY_TARGET;
    const llmBaseUrl =
      config.LLM_GATEWAY_BASE_URL ||
      (llmProxyMode ? `${kortixOrigin}/v1/llm-gateway/v1/llm` : `${kortixOrigin}/v1/llm`);

    const fullEnv: Record<string, string> = {
      ...input.builtEnvVars,
      ...(executorToken ? { KORTIX_EXECUTOR_TOKEN: executorToken, KORTIX_CLI_TOKEN: executorToken } : {}),
      ...(gatewayLlmKey ? { KORTIX_LLM_API_KEY: gatewayLlmKey, KORTIX_LLM_BASE_URL: llmBaseUrl, KORTIX_YOLO_API_KEY: gatewayLlmKey, KORTIX_YOLO_URL: llmBaseUrl } : {}),
    };
    delete fullEnv.KORTIX_TOKEN; // never overwrite the box's park token

    const staged = await stageClaimEnv(spare.externalId, spare.serviceKey, input.userId, fullEnv);
    if (!staged) {
      await releaseSpare(spare.spareSandboxId, 'parked');
      return null;
    }
    const bound = await bindClaimedSpare({ spare, sessionId: input.sessionId, accountId: input.accountId, projectId: input.projectId, provider: input.provider, sessionMetadata: input.sessionMetadata });
    if (!bound) return null;
    console.log(`[warm-pool] claimed spare ${spare.spareSandboxId.slice(0, 8)} → session ${input.sessionId.slice(0, 8)}`);
    return { externalId: spare.externalId };
  } catch (err) {
    console.warn('[warm-pool] claimSpareForSession failed:', err instanceof Error ? err.message : err);
    if (spare) await releaseSpare(spare.spareSandboxId, 'parked').catch(() => {});
    return null;
  }
}

// ── Refill + presence + reconcile ────────────────────────────────────────────

/** Reap a project's spares this long after its last presence heartbeat — the
 *  fallback for a tab that closed WITHOUT firing its leave beacon (crash, network
 *  drop, hard kill). The leave beacon reaps immediately; this just bounds the
 *  worst case to ~3× the client heartbeat interval. */
const POOL_PRESENCE_STALE_MS = 3 * 60 * 1000;
/** Per-pod write throttle so a burst of project requests doesn't upsert presence
 *  on every call — one write per project per window is plenty (heartbeat ~45s). */
const PRESENCE_WRITE_THROTTLE_MS = 20_000;

/** Per-pod throttle of the presence upsert (projectId → last DB-write ms). */
const presenceWroteAt = new Map<string, number>();
const refillInFlight = new Set<string>();

/** Record that a user has the project OPEN: refresh the cross-pod DB presence row
 *  (so the leader reconcile sees it) and kick a refill so a spare is ready. The
 *  DB write is throttled per project per pod; the refill is idempotent. */
export function notePoolPresence(projectId: string, accountId?: string | null): void {
  if (!warmPoolEnabled() || !projectId || !accountId) return;
  const now = Date.now();
  const last = presenceWroteAt.get(projectId) ?? 0;
  if (now - last >= PRESENCE_WRITE_THROTTLE_MS) {
    presenceWroteAt.set(projectId, now);
    const seen = new Date(now);
    void db
      .insert(warmPoolPresence)
      .values({ projectId, accountId, lastSeenAt: seen })
      .onConflictDoUpdate({ target: warmPoolPresence.projectId, set: { lastSeenAt: seen, accountId } })
      .catch((err) => console.warn('[warm-pool] presence upsert failed:', err instanceof Error ? err.message : err));
  }
  void refillProjectPool(projectId).catch(() => {});
}

/** The user left the project (tab closed/hidden): drop presence and reap its
 *  parked/booting spares immediately, so cost tracks projects-open-now instead of
 *  the 6h age rule. Best-effort. */
export async function dropPoolPresence(projectId: string): Promise<void> {
  if (!projectId) return;
  presenceWroteAt.delete(projectId);
  await db.delete(warmPoolPresence).where(eq(warmPoolPresence.projectId, projectId)).catch(() => {});
  await reapProjectSpares(projectId).catch((err) =>
    console.warn('[warm-pool] leave-reap failed:', err instanceof Error ? err.message : err),
  );
}

/** Reap every parked/booting spare for a project (leave + stale-presence reap).
 *  Never touches 'claiming' rows — a live claim is in flight there. */
async function reapProjectSpares(projectId: string): Promise<number> {
  const rows = await db
    .select({ sandboxId: sessionSandboxes.sandboxId, externalId: sessionSandboxes.externalId, provider: sessionSandboxes.provider })
    .from(sessionSandboxes)
    .where(and(eq(sessionSandboxes.projectId, projectId), inArray(sessionSandboxes.poolState, ['booting', 'parked'])));
  for (const row of rows) await reapWarmSandbox(row);
  return rows.length;
}

/** Bring a project's parked spares toward each opted-in template's size
 *  (best-effort). Each sandbox template the project turned ON is refilled
 *  independently toward its own ready-count, bounded by the global cap. */
export async function refillProjectPool(projectId: string, _forUserId?: string | null): Promise<void> {
  if (!warmPoolEnabled()) return;
  if (refillInFlight.has(projectId)) return;
  refillInFlight.add(projectId);
  try {
    const [project] = await db
      .select({ projectId: projects.projectId, accountId: projects.accountId, repoUrl: projects.repoUrl, defaultBranch: projects.defaultBranch, manifestPath: projects.manifestPath, metadata: projects.metadata })
      .from(projects)
      .where(eq(projects.projectId, projectId))
      .limit(1);
    if (!project || !project.repoUrl) return;

    const wantTemplates = listProjectWarmTemplates(project.metadata).filter((t) => t.enabled && t.size > 0);
    if (wantTemplates.length === 0) return;

    // Don't pre-warm an account that can't create sessions: session-create 402s
    // for it (assertBillingActive), so any spare we'd park can never be claimed —
    // it would just burn a box (and the account's credits) for nothing. Mirrors
    // the session-create billing gate.
    if (!(await checkBillingActive(project.accountId)).ok) return;

    const countsBySlug = await getWarmCountsBySlug(projectId);

    // Resolve a git auth token once so spares can build the snapshot if needed.
    let gitAuthToken: string | null = null;
    try {
      const { resolveProjectGitAuth } = await import('../../projects/lib/git');
      gitAuthToken = (await resolveProjectGitAuth(project as any)).auth?.token ?? null;
    } catch { /* cache-hit boots don't need it */ }

    // No global cap — each opted-in template warms toward its own size. Cost is
    // bounded per-account (billing gate), per-template (size ≤ 25), by presence-
    // reap, and by the provider's autoStop clamp.
    const spawns: Array<Promise<void>> = [];
    for (const t of wantTemplates) {
      const have = countsBySlug.get(t.slug) ?? { ready: 0, warming: 0 };
      const want = t.size - (have.ready + have.warming);
      if (want <= 0) continue;
      for (let i = 0; i < want; i++) spawns.push(spawnSpare(project, t.slug, gitAuthToken));
    }
    await Promise.allSettled(spawns);
  } catch (err) {
    console.warn('[warm-pool] refill failed:', err instanceof Error ? err.message : err);
  } finally {
    refillInFlight.delete(projectId);
  }
}

/**
 * Periodic reconcile (wired into project-maintenance). Reaps dead/aged/stuck pool
 * rows; when enabled, refills present projects. When DISABLED, reaps every pool
 * row (orphans from a prior enabled run) and creates nothing.
 */
export async function reconcileWarmPool(now = new Date()): Promise<{ reaped: number; projects: number }> {
  let reaped = 0;
  const enabled = warmPoolEnabled();

  // Present projects = a fresh presence heartbeat, read from the DB (cross-pod,
  // so the leader sees presence recorded on any pod).
  const presentCutoff = new Date(now.getTime() - POOL_PRESENCE_STALE_MS);
  const presentRows = enabled
    ? await db
        .select({ projectId: warmPoolPresence.projectId })
        .from(warmPoolPresence)
        .where(gte(warmPoolPresence.lastSeenAt, presentCutoff))
    : [];
  const present = new Set(presentRows.map((r) => r.projectId));
  // Prune stale presence rows so the table stays small.
  await db.delete(warmPoolPresence).where(lt(warmPoolPresence.lastSeenAt, presentCutoff)).catch(() => {});

  const poolRows = await db
    .select({
      sandboxId: sessionSandboxes.sandboxId,
      projectId: sessionSandboxes.projectId,
      externalId: sessionSandboxes.externalId,
      provider: sessionSandboxes.provider,
      poolState: sessionSandboxes.poolState,
      status: sessionSandboxes.status,
      createdAt: sessionSandboxes.createdAt,
      updatedAt: sessionSandboxes.updatedAt,
    })
    .from(sessionSandboxes)
    .where(inArray(sessionSandboxes.poolState, ['booting', 'parked', 'claiming', 'reap']));

  for (const row of poolRows) {
    // Reap when: disabled; the box is dead/aged/stuck (warmBoxReapReason); OR its
    // project is no longer present (tab closed — usually the leave beacon already
    // reaped, this catches missed beacons). Never presence-reap a 'claiming' row:
    // a live claim is binding it (a dead claimant is still caught by claim-timeout).
    const presenceReap =
      enabled && row.poolState !== 'claiming' && !!row.projectId && !present.has(row.projectId);
    const reason = !enabled
      ? 'disabled'
      : warmBoxReapReason(row, now.getTime()) || (presenceReap ? 'no-presence' : null);
    if (reason) {
      await reapWarmSandbox(row);
      reaped++;
    }
  }
  if (!enabled) return { reaped, projects: 0 };

  // Refill present projects toward their per-project SIZE.
  let refilled = 0;
  for (const projectId of present) {
    await refillProjectPool(projectId);
    refilled++;
  }
  return { reaped, projects: refilled };
}

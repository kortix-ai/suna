/**
 * Warm sandbox pre-warm — API driver for the daemon's KORTIX_WARM_POOL mode.
 *
 * GATED OFF BY DEFAULT (config.KORTIX_WARM_POOL_MAX_TOTAL = 0 ⇒ warmPoolEnabled()
 * false). When disabled, every exported entry point is inert: the allocator
 * skips the claim path and cold-provisions byte-identically to today, and
 * reconcile only reaps stray pool rows. Enable (MAX_TOTAL > 0) ONLY after
 * live-validating the claim path on a real deploy — the daemon runPoolMode claim
 * behaviour (clone + opencode warm post-claim) can't be unit-tested.
 *
 * Design (decoupled from the durable session id — unlike the retired pool):
 *   - spawnSpare:  provision a SESSION-LESS box with env KORTIX_WARM_POOL=1 so the
 *                  daemon boots runPoolMode (opencode + proxy up, parked). The
 *                  row's sandbox_id is a throwaway SPARE uuid (NOT a session id).
 *   - claim:       createProjectSession owns the session id; the allocator calls
 *                  claimSpareForSession, which atomically grabs a parked spare,
 *                  stages the session env into the box (/tmp/dnah-env via the
 *                  daemon /file/upload — the daemon's env-poll then clones +
 *                  warms), and BINDS a fresh session_sandboxes row keyed
 *                  sandbox_id == session_id at the spare's external_id.
 *   - any miss/error ⇒ return null ⇒ allocator cold-falls-back unchanged.
 *
 * The box keeps its PARK-time KORTIX_TOKEN (the claim env deliberately omits it),
 * so the claimed row's config.serviceKey MUST stay the park key — the proxy
 * authenticates upstream with it.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';

import { projects, projectSessions, sessionSandboxes } from '@kortix/db';
import { config, type SandboxProviderName } from '../../config';
import { db } from '../../shared/db';
import { getProvider } from '../providers';
import { selectProvider } from './provider-balancer';
import { createApiKey } from '../../repositories/api-keys';
import { createAccountToken } from '../../repositories/account-tokens';
import { accountEntitledToLlmGateway } from '../../shared/account-limits';
import { checkBillingActive } from '../../billing/services/billing-gate';
import { ensureSandboxImage, DEFAULT_SANDBOX_SLUG } from '../../snapshots/builder';
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
const DNAH_ENV_PATH = '/tmp/dnah-env'; // MUST match the daemon (main.ts reloadSessionEnv + poll)
const DAEMON_PORT = 8000;

export interface WarmPoolConfig {
  enabled: boolean;
  size: number;
}

/** Master gate. False at the default (MAX_TOTAL=0) ⇒ the whole driver is inert. */
export const warmPoolEnabled = (): boolean => config.KORTIX_WARM_POOL_MAX_TOTAL > 0;

/** Effective per-project warm config. `enabled` is false unless the pool is on
 *  AND the project hasn't opted out (projects.metadata.warm_pool.enabled). */
export function resolveWarmConfig(metadata: unknown): WarmPoolConfig {
  const defaultSize = Math.max(0, config.KORTIX_WARM_POOL_SIZE);
  const wp = (metadata as Record<string, unknown> | null | undefined)?.warm_pool;
  if (wp && typeof wp === 'object' && !Array.isArray(wp)) {
    const raw = wp as Record<string, unknown>;
    const optedOut = raw.enabled === false;
    const size =
      typeof raw.size === 'number' && Number.isInteger(raw.size) && raw.size >= 0
        ? Math.min(raw.size, MAX_WARM_SIZE)
        : defaultSize;
    return { enabled: warmPoolEnabled() && !optedOut, size };
  }
  return { enabled: warmPoolEnabled(), size: defaultSize };
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

async function countGlobalWarm(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(sessionSandboxes)
    .where(inArray(sessionSandboxes.poolState, ['booting', 'parked', 'claiming']))
    .limit(1);
  return Number(row?.n ?? 0);
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

/** Provision one session-less spare for a project (boots the daemon's pool mode). */
async function spawnSpare(project: {
  projectId: string;
  accountId: string;
  repoUrl: string | null;
  defaultBranch: string;
  manifestPath: string | null;
  metadata?: unknown;
}, gitAuthToken: string | null): Promise<void> {
  if (!project.repoUrl) return;
  const spareId = randomUUID();
  const provider = await selectProvider();
  try {
    // The spare's KORTIX_TOKEN (the box stays authenticated with this through the
    // claim — the claim env never overwrites it), persisted as config.serviceKey
    // so the proxy + the claim-write can authenticate to the box.
    const sandboxKey = await createApiKey({ sandboxId: spareId, accountId: project.accountId, title: 'Warm Spare Token', type: 'sandbox' });

    const projMeta = (project.metadata ?? {}) as Record<string, unknown>;
    const rawSlug = typeof projMeta.default_sandbox_slug === 'string' ? projMeta.default_sandbox_slug.trim() : '';
    const slug = rawSlug || DEFAULT_SANDBOX_SLUG;

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
      metadata: { warmSpare: true },
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
    // /kortix/health bypasses the daemon auth gate, so it answers before claim.
    let healthy = false;
    try {
      const { url } = await resolvePreviewLink(externalId, DAEMON_PORT);
      const r = await fetch(`${url.replace(/\/$/, '')}/kortix/health`, { signal: AbortSignal.timeout(8_000) });
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

/** Atomically take one parked spare (flip parked→claiming). Single statement +
 *  SKIP LOCKED so concurrent creates never grab the same spare. */
async function claimSpare(projectId: string): Promise<ClaimedSpare | null> {
  const res = await db.execute(sql`
    UPDATE kortix.session_sandboxes
    SET pool_state = 'claiming', updated_at = now()
    WHERE sandbox_id = (
      SELECT s.sandbox_id FROM kortix.session_sandboxes s
      WHERE s.project_id = ${projectId}
        AND s.pool_state = 'parked'
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

/** Stage the session env into the spare box's /tmp/dnah-env via the daemon's
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
    form.append(DNAH_ENV_PATH, new Blob([body], { type: 'text/plain' }), 'dnah-env');
    const res = await fetch(`${url.replace(/\/$/, '')}/file/upload`, { method: 'POST', headers, body: form, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      console.warn(`[warm-pool] claim env stage → ${res.status}`);
      return false;
    }
    // writeUploadUnique never overwrites: a collision lands at a SUFFIXED path the
    // daemon never reads. Confirm the bytes landed exactly at DNAH_ENV_PATH.
    const out = (await res.json().catch(() => null)) as Array<{ path?: string }> | null;
    const landed = Array.isArray(out) && out.some((r) => r?.path === DNAH_ENV_PATH);
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
    // ATOMIC: insert the session row + delete the spare row in ONE tx. Both rows
    // share the same external_id; if the spare row lingered (insert ok, delete
    // failed) a later claim-timeout reap would provider.remove() the box out
    // from under the now-bound session. The tx makes "bound" ⇒ "spare row gone".
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
  /** The exact env the cold path would inject (buildSessionSandboxEnvVars output). */
  builtEnvVars: Record<string, string>;
  sessionMetadata: Record<string, unknown>;
}

/**
 * THE single entry the allocator calls. Returns { externalId } on a successful
 * warm claim, or null on any miss/error (⇒ cold fallback). Never throws.
 */
export async function claimSpareForSession(input: ClaimSpareForSessionInput): Promise<{ externalId: string } | null> {
  if (!warmPoolEnabled()) return null;
  let spare: ClaimedSpare | null = null;
  try {
    spare = await claimSpare(input.projectId);
    if (!spare) return null;

    // Per-session executor/LLM tokens — delivered via the claim env file and read
    // fresh by the daemon's loadConfig on reload (NOT the sandbox KORTIX_TOKEN,
    // which stays the spare's park key).
    let executorToken: string | null = null;
    try {
      executorToken = (await createAccountToken({ accountId: input.accountId, userId: input.userId, projectId: input.projectId, name: `Executor Session ${input.sessionId.slice(0, 8)}` })).secretKey;
    } catch (err) {
      console.warn('[warm-pool] executor token mint failed:', err instanceof Error ? err.message : err);
    }
    const gatewayEntitled = config.LLM_GATEWAY_ENABLED ? await accountEntitledToLlmGateway(input.accountId).catch(() => false) : false;
    const gatewayLlmKey = config.LLM_GATEWAY_ENABLED && gatewayEntitled ? executorToken : null;
    const llmBaseUrl = `${config.KORTIX_URL.replace(/\/+$/, '')}/v1/llm`;

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

/** Per-instance presence map (projectId → last-seen ms) gating refill. */
const presenceSeen = new Map<string, number>();
const refillInFlight = new Set<string>();

/** Record that a user is present in a project; kick a refill so a spare is ready. */
export function notePoolPresence(projectId: string, userId?: string | null): void {
  if (!warmPoolEnabled() || !projectId) return;
  presenceSeen.set(projectId, Date.now());
  void refillProjectPool(projectId, userId).catch(() => {});
}

/** Bring a project's parked spares toward its desired size (best-effort). */
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
    // Don't pre-warm an account that can't create sessions: session-create 402s
    // for it (assertBillingActive), so any spare we'd park can never be claimed —
    // it would just consume the global MAX_TOTAL cap and starve projects that CAN
    // use one (the dominant reason a returning user's project had no spare ready
    // → cold start). Mirrors the session-create billing gate.
    if (!(await checkBillingActive(project.accountId)).ok) return;
    const cfg = resolveWarmConfig(project.metadata);
    if (!cfg.enabled || cfg.size <= 0) return;

    const { ready, warming } = await getWarmPoolCounts(projectId);
    const globalRemaining = config.KORTIX_WARM_POOL_MAX_TOTAL - (await countGlobalWarm());
    const want = Math.max(0, Math.min(cfg.size - (ready + warming), globalRemaining));
    if (want <= 0) return;

    // Resolve a git auth token once so spares can build the snapshot if needed.
    let gitAuthToken: string | null = null;
    try {
      const { resolveProjectGitAuth } = await import('../../projects/lib/git');
      gitAuthToken = (await resolveProjectGitAuth(project as any)).auth?.token ?? null;
    } catch { /* cache-hit boots don't need it */ }

    await Promise.allSettled(Array.from({ length: want }, () => spawnSpare(project, gitAuthToken)));
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

  const enabled = warmPoolEnabled();
  for (const row of poolRows) {
    const reason = enabled ? warmBoxReapReason(row, now.getTime()) : 'disabled';
    if (reason) {
      await reapWarmSandbox(row);
      reaped++;
    }
  }
  if (!enabled) return { reaped, projects: 0 };

  // Refill projects with fresh presence.
  const cutoff = now.getTime() - config.KORTIX_WARM_POOL_PRESENCE_MINUTES * 60_000;
  let refilled = 0;
  for (const [projectId, seenAt] of presenceSeen) {
    if (seenAt < cutoff) { presenceSeen.delete(projectId); continue; }
    await refillProjectPool(projectId);
    refilled++;
  }
  return { reaped, projects: refilled };
}

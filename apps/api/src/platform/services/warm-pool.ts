/**
 * Warm sandbox pool — per-project pre-booted sandboxes ready to claim instantly.
 * See docs/specs/warm-pool.md.
 *
 * A warm sandbox is a normal session boot for a pre-allocated id `W` (which is
 * both its sandbox_id AND its future session_id, preserving the
 * sandbox_id == session_id == branch invariant), minus the project_sessions row
 * and minus the initial prompt. It clones base + creates branch W + warms
 * opencode, then waits in `pool_state='parked'`.
 *
 * Claim is a pure DB op (no call into the sandbox): flip parked→claimed and
 * insert the project_sessions row. On by default; the fleet kill switch is
 * KORTIX_WARM_POOL_MAX_TOTAL=0.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { accountMembers, projects, sessionSandboxes } from '@kortix/db';
import { db } from '../../shared/db';
import { config } from '../../config';
import { getProvider } from '../providers';
import { selectProvider } from './provider-balancer';
import { provisionSessionSandbox } from './session-sandbox';

const POOL_BOOT_TIMEOUT_MS = 8 * 60 * 1000; // booting longer than this → failed → reap
const POOL_MAX_AGE_MS = 6 * 60 * 60 * 1000; // parked longer than this → cycle (snapshot drift)
const READY_PROBE_TIMEOUT_MS = 5 * 60 * 1000;
// How often we probe a booting box for readiness before flipping it to 'parked'.
// Kept tight: at 3s a box could sit runtimeReady (but still unclaimable-as-parked,
// with no pre-created opencode session pin) for up to ~3s, so a click in that
// window claims it as 'booting' and pays a missing-pin ensure-opencode round-trip.
// 600ms shrinks that dead window to near-zero with only minor extra probe traffic.
const READY_PROBE_INTERVAL_MS = 600;
const resumedPromotions = new Set<string>();

// Warm pool is ON by default — there's no enable flag. The fleet-wide kill
// switch is KORTIX_WARM_POOL_MAX_TOTAL=0. Each project can still opt in/out and
// pick a size from the UI (Customize → Sandbox), stored in
// projects.metadata.warm_pool — DB only, never in kortix.toml.
export const warmPoolEnabled = (): boolean => config.KORTIX_WARM_POOL_MAX_TOTAL > 0;

// Per-project sanity cap on warm size. The real fleet bound is the operator's
// KORTIX_WARM_POOL_MAX_TOTAL; this just stops a typo from warming a huge pool.
const MAX_WARM_SIZE = 25;
export interface WarmPoolConfig {
  enabled: boolean;
  size: number;
}

/** Effective per-project warm config: the UI value (projects.metadata.warm_pool)
 * over the operator default (enabled / KORTIX_WARM_POOL_SIZE). */
export function resolveWarmConfig(metadata: unknown): WarmPoolConfig {
  const defaultSize = Math.max(0, config.KORTIX_WARM_POOL_SIZE);
  const wp = (metadata as Record<string, unknown> | null | undefined)?.warm_pool;
  if (wp && typeof wp === 'object' && !Array.isArray(wp)) {
    const raw = wp as Record<string, unknown>;
    const enabled = typeof raw.enabled === 'boolean' ? raw.enabled : true;
    const size =
      typeof raw.size === 'number' && Number.isInteger(raw.size) && raw.size >= 0
        ? Math.min(raw.size, MAX_WARM_SIZE)
        : defaultSize;
    return { enabled, size };
  }
  return { enabled: true, size: defaultSize };
}

/**
 * Why a parked/booting box should be reaped, or null to keep it. Pure so it's
 * unit-testable. `pool_state='reap'` is set by a failed readiness promotion.
 */
export function warmBoxReapReason(
  row: { poolState: string | null; status: string; createdAt: Date; updatedAt: Date },
  now: number,
  opts: { bootTimeoutMs?: number; maxAgeMs?: number } = {},
): string | null {
  const bootTimeoutMs = opts.bootTimeoutMs ?? POOL_BOOT_TIMEOUT_MS;
  const maxAgeMs = opts.maxAgeMs ?? POOL_MAX_AGE_MS;
  if (row.poolState === 'reap') return 'marked';
  if (row.status === 'error') return 'errored';
  if (row.poolState === 'booting' && now - row.createdAt.getTime() > bootTimeoutMs) return 'boot-timeout';
  if (row.poolState === 'parked' && now - row.createdAt.getTime() > maxAgeMs) return 'aged-out';
  return null;
}

async function getProjectOwnerUserId(accountId: string): Promise<string | null> {
  const [owner] = await db
    .select({ userId: accountMembers.userId })
    .from(accountMembers)
    .where(and(eq(accountMembers.accountId, accountId), eq(accountMembers.accountRole, 'owner')))
    .limit(1);
  return owner?.userId ?? null;
}

async function countGlobalWarm(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(sessionSandboxes)
    .where(inArray(sessionSandboxes.poolState, ['booting', 'parked']))
    .limit(1);
  return Number(row?.n ?? 0);
}

/** Live warm-pool counts for a project: `ready` (parked, claimable) +
 * `warming` (booting). Surfaced in the Customize → Sandbox card. */
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

/**
 * Atomically claim a warm sandbox for `projectId` on behalf of `userId`.
 *
 * GREEDY: prefer a fully-parked box (instant), but if none is ready yet, claim
 * one that's still `booting` — it already has a head start (clone + opencode in
 * flight), so the session rides it to ready far faster than a fresh cold boot.
 * This is what makes "every create assumes a warm one" hold even during the
 * ~25s warm-up window right after a user opens a project. Only claims boxes
 * booted for the same user (owner), which carry that user's executor/LLM tokens.
 * Returns the claimed sandbox, or null (→ cold path).
 */
export async function claimWarmSandbox(input: {
  projectId: string;
  userId: string;
  /** Template slug the session wants ('default' = platform default). Boxes
   * record the slug they were spawned for — a claim only matches a box built
   * for the SAME template. */
  slug?: string;
}): Promise<{ sandboxId: string; externalId: string | null; accountId: string; sandboxStatus: string; opencodeSessionId: string | null } | null> {
  if (!warmPoolEnabled()) return null;
  const wantedSlug = (input.slug ?? '').trim() || 'default';
  // Single statement, locked with SKIP LOCKED so concurrent claims never
  // collide. Prefer parked over booting, and oldest-first (= most booted).
  // Clearing pool_state hands the box to the session (the idle sweep then
  // hibernates it normally; promoteWhenReady sees it's no longer 'booting' and
  // stops without reaping). status='error' boxes are never claimed.
  const claimed = await db.execute(sql`
    UPDATE kortix.session_sandboxes
    SET pool_state = NULL, updated_at = now()
    WHERE sandbox_id = (
      SELECT s.sandbox_id FROM kortix.session_sandboxes s
      WHERE s.project_id = ${input.projectId}
        AND s.pool_state IN ('parked', 'booting')
        AND s.status <> 'error'
        AND (s.metadata->'warmPool'->>'ownerUserId') = ${input.userId}
        AND coalesce(s.metadata->'warmPool'->>'slug', 'default') = ${wantedSlug}
      ORDER BY (s.pool_state = 'parked') DESC, s.created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING sandbox_id, external_id, account_id, status, metadata
  `);
  const r = (claimed as unknown as { rows?: any[] }).rows ?? (claimed as unknown as any[]);
  const row = Array.isArray(r) ? r[0] : undefined;
  if (!row) return null;
  const meta = (row.metadata ?? {}) as Record<string, any>;
  return {
    sandboxId: row.sandbox_id as string,
    externalId: (row.external_id ?? null) as string | null,
    accountId: row.account_id as string,
    sandboxStatus: (row.status ?? 'provisioning') as string,
    // Pin pre-warmed at park time (see promoteWhenReady) → claim skips ensure-opencode.
    opencodeSessionId: (meta.warmPool?.opencodeSessionId ?? null) as string | null,
  };
}

/**
 * After claiming a warm box, fast-forward its workspace to the LATEST base tip.
 * The box cloned base when it parked, so base may have advanced since — without
 * this, a claimed session opens on a stale checkout. Fire-and-forget + no
 * opencode restart (the daemon's file watcher picks up the changed files).
 */
export async function syncClaimedBoxToBase(externalId: string | null, userId: string | undefined): Promise<void> {
  if (!externalId) return;
  try {
    const { sandboxOpencodeEndpoint } = await import('../../projects/opencode-mapping');
    const ep = await sandboxOpencodeEndpoint(externalId, userId);
    if (!ep) return;
    const res = await fetch(`${ep.url}/kortix/refresh?base=1&restart=0`, {
      method: 'POST',
      headers: ep.headers,
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) {
      console.warn(`[warm-pool] base sync ${externalId.slice(0, 8)} -> ${res.status}`);
    }
  } catch (err) {
    console.warn('[warm-pool] base sync failed:', err instanceof Error ? err.message : err);
  }
}

/** Probe the daemon health through the local proxy using the sandbox key. */
async function probeRuntimeReady(externalId: string, serviceKey: string): Promise<{ ready: boolean; error: string | null }> {
  try {
    const url = `http://127.0.0.1:${config.PORT}/v1/p/${externalId}/8000/kortix/health`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${serviceKey}` } });
    const b = (await r.json().catch(() => null)) as any;
    return { ready: b?.runtimeReady === true, error: b?.boot_error ?? null };
  } catch {
    return { ready: false, error: null };
  }
}

/** Background: poll until the booting box is runtimeReady, then mark it parked. */
async function promoteWhenReady(sandboxId: string): Promise<void> {
  const deadline = Date.now() + READY_PROBE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, READY_PROBE_INTERVAL_MS));
    const [row] = await db
      .select({ poolState: sessionSandboxes.poolState, externalId: sessionSandboxes.externalId, status: sessionSandboxes.status, config: sessionSandboxes.config, metadata: sessionSandboxes.metadata })
      .from(sessionSandboxes)
      .where(eq(sessionSandboxes.sandboxId, sandboxId))
      .limit(1);
    if (!row || row.poolState !== 'booting') return; // claimed/reaped/gone elsewhere
    if (row.status === 'error') break;
    const serviceKey = (row.config as Record<string, unknown> | null)?.serviceKey as string | undefined;
    if (!row.externalId || !serviceKey) continue;
    const { ready, error } = await probeRuntimeReady(row.externalId, serviceKey);
    if (ready) {
      const meta = (row.metadata ?? {}) as Record<string, any>;
      // Pre-warm the opencode session so a claim skips the ensure-opencode
      // round trip — the pin is already there → chat is usable immediately.
      let opencodeSessionId: string | null = null;
      try {
        const { createSandboxOpencodeSession } = await import('../../projects/opencode-mapping');
        opencodeSessionId = await createSandboxOpencodeSession(row.externalId, meta.warmPool?.ownerUserId);
      } catch (err) {
        console.warn(`[warm-pool] pre-warm opencode session failed for ${sandboxId.slice(0, 8)}:`, err instanceof Error ? err.message : err);
      }
      await db
        .update(sessionSandboxes)
        .set({
          poolState: 'parked',
          metadata: { ...meta, warmPool: { ...(meta.warmPool ?? {}), opencodeSessionId } },
          updatedAt: new Date(),
        })
        .where(eq(sessionSandboxes.sandboxId, sandboxId));
      console.log(`[warm-pool] parked ${sandboxId.slice(0, 8)}${opencodeSessionId ? ' (opencode pre-warmed)' : ''}`);
      return;
    }
    if (error) break;
  }
  await db.update(sessionSandboxes).set({ poolState: 'reap', updatedAt: new Date() }).where(eq(sessionSandboxes.sandboxId, sandboxId)).catch(() => {});
  console.warn(`[warm-pool] ${sandboxId.slice(0, 8)} never became ready → reap`);
}

/** Provision one warm sandbox for a project (booted for its owner). */
async function spawnWarmSandbox(project: {
  projectId: string;
  accountId: string;
  repoUrl: string | null;
  defaultBranch: string;
  manifestPath: string | null;
  metadata?: unknown;
}, forUserId?: string | null): Promise<boolean> {
  // Warm the box for the user who's actually PRESENT (and will therefore claim
  // it) — not always the account owner. claimWarmSandbox matches the box's
  // stamped user against the acting session-creator, so an owner-stamped box can
  // ONLY ever be claimed by the owner: every non-owner member would cold-miss
  // AND burn an unclaimable box on each refill. Falling back to the owner keeps
  // owner-driven warming (CR/trigger/config-change paths with no present user).
  const targetUserId = forUserId ?? (await getProjectOwnerUserId(project.accountId));
  if (!targetUserId || !project.repoUrl) return false;
  const W = randomUUID();
  const provider = await selectProvider();
  // The project's default template ([sandbox] default, synced to metadata by
  // the TOML sync). Pool boxes boot THAT template, so custom-template projects
  // get warm claims too — previously the pool was platform-default only.
  const projMeta = (project.metadata ?? {}) as Record<string, unknown>;
  const rawSlug = typeof projMeta.default_sandbox_slug === 'string' ? projMeta.default_sandbox_slug.trim() : '';
  const poolSlug = rawSlug || 'default';
  // Lazy import to avoid a load-time cycle with projects/index.ts.
  const { buildSessionSandboxEnvVars } = await import('../../projects');
  const extraEnvVars = await buildSessionSandboxEnvVars({
    accountId: project.accountId,
    projectId: project.projectId,
    sessionId: W,
    userId: targetUserId,
    repoUrl: project.repoUrl,
    baseRef: project.defaultBranch,
    agentName: 'default',
    initialPrompt: null,
  });
  await provisionSessionSandbox({
    sandboxId: W,
    accountId: project.accountId,
    projectId: project.projectId,
    userId: targetUserId,
    provider,
    extraEnvVars,
    sandboxSlug: poolSlug === 'default' ? undefined : poolSlug,
    // A pool box's whole value is opencode ALREADY RUNNING when claimed. It
    // gets that by booting normally (clone → daemon → opencode) and parking.
    // The experimental warm SNAPSHOT can't help here: it kills opencode before
    // snapshotting (warm-project.ts) so a restored box re-starts opencode
    // anyway, AND it lives on the flaky experimental region — so routing pool
    // fills through it only adds failed attempts before falling back. Boot pool
    // boxes COLD on the reliable default region: same time-to-parked, no flaky
    // dependency, so the pool actually stays full (which is what makes claims
    // ~2s). (Revisit if/when a memory-preserving restore that keeps opencode
    // running lands on a stable region — then pool refills could skip the boot.)
    disableWarmSnapshot: true,
    poolState: 'booting',
    metadata: {
      warmPool: {
        slug: poolSlug,
        // Key name kept as `ownerUserId` for claim-predicate compatibility, but
        // it holds the user this box was warmed FOR (present user, else owner).
        ownerUserId: targetUserId,
        secretRevision: extraEnvVars.KORTIX_PROJECT_SECRETS_REVISION ?? null,
        bootedAt: new Date().toISOString(),
      },
    },
    gitProject: {
      projectId: project.projectId,
      repoUrl: project.repoUrl,
      defaultBranch: project.defaultBranch,
      manifestPath: project.manifestPath ?? '',
      gitAuthToken: null,
    },
    baseRef: project.defaultBranch,
  });
  void promoteWhenReady(W).catch(() => {});
  console.log(`[warm-pool] spawning ${W.slice(0, 8)} for project ${project.projectId.slice(0, 8)}`);
  return true;
}

async function reapWarmSandbox(row: { sandboxId: string; externalId: string | null; provider: string }): Promise<void> {
  try {
    if (row.externalId) await getProvider(row.provider as any).remove(row.externalId);
  } catch (err) {
    console.warn(`[warm-pool] provider remove failed for ${row.sandboxId.slice(0, 8)}:`, err instanceof Error ? err.message : err);
  }
  await db.delete(sessionSandboxes).where(eq(sessionSandboxes.sandboxId, row.sandboxId)).catch(() => {});
}

/**
 * Per-project refill coalescing guard (per process). refillProjectPool is fanned
 * out from many concurrent triggers — claim-empty + post-claim (sessions.ts),
 * presence (access.ts / r1.ts), config change (r5.ts), and the periodic
 * reconcile. Sizing the deficit off the PARKED count (below) means concurrent
 * refills would each see the same parked deficit and each spawn it, overshooting
 * `size` and burning the global cap. Coalescing collapses a burst into one refill;
 * cross-instance overshoot is still bounded by the global cap + the reconcile reap.
 */
const refillInFlight = new Set<string>();

/**
 * Kick a single project's pool toward its desired size (best-effort, fire and
 * forget). Called reactively right after a claim so the pool refills fast.
 */
export async function refillProjectPool(projectId: string, forUserId?: string | null): Promise<void> {
  if (!warmPoolEnabled()) return;
  if (refillInFlight.has(projectId)) return; // a refill for this project is already running
  refillInFlight.add(projectId);
  try {
    const [project] = await db
      .select({ projectId: projects.projectId, accountId: projects.accountId, repoUrl: projects.repoUrl, defaultBranch: projects.defaultBranch, manifestPath: projects.manifestPath, metadata: projects.metadata })
      .from(projects)
      .where(eq(projects.projectId, projectId))
      .limit(1);
    if (!project) return;
    const cfg = resolveWarmConfig(project.metadata);
    if (!cfg.enabled || cfg.size <= 0) return;
    // Presence implies the user is (back) in this project — if its per-project
    // warm snapshot was reclaimed while dormant (quota GC) or never baked, kick
    // a re-bake now so upcoming sessions and pool refills boot clone-free.
    // Deduped + custom-template-aware inside kickProjectWarmBake.
    {
      const { readProjectWarmPointer, kickProjectWarmBake } = await import('../../snapshots/warm-project');
      if (!readProjectWarmPointer(project.metadata)) kickProjectWarmBake(project);
    }
    // Size the deficit off the PARKED (instantly claimable) count, NOT live
    // (parked + booting). A just-spawned booting replacement isn't claimable for
    // ~20-30s, so counting it as "live" lets the pool sit at parked=0 while rapid
    // creates cold-miss. Spawning toward the parked target keeps a ready box in
    // front of the user. Bound total in-flight (parked + booting) by a small
    // headroom over `size` so booting boxes can't pile up unbounded.
    const { ready: parked, warming: booting } = await getWarmPoolCounts(projectId);
    const maxLive = cfg.size + Math.ceil(cfg.size / 2);
    const parkedDeficit = cfg.size - parked;
    const liveHeadroom = maxLive - (parked + booting);
    const globalRemaining = config.KORTIX_WARM_POOL_MAX_TOTAL - (await countGlobalWarm());
    const want = Math.max(0, Math.min(parkedDeficit, liveHeadroom, globalRemaining));
    if (want > 0) {
      // Spawn concurrently — each box is independent (own id + detached boot) and
      // only the cheap setup round-trips are awaited, so a serial loop would just
      // lengthen time-to-pool-full. Per-spawn .catch keeps one failure from
      // aborting the batch; the in-flight guard is held until all rows land.
      await Promise.allSettled(
        Array.from({ length: want }, () =>
          spawnWarmSandbox(project, forUserId).catch((err) => console.warn('[warm-pool] spawn failed:', err instanceof Error ? err.message : err)),
        ),
      );
    }
  } catch (err) {
    console.warn('[warm-pool] refill failed:', err instanceof Error ? err.message : err);
  } finally {
    refillInFlight.delete(projectId);
  }
}

/** Per-instance throttle so portal activity doesn't hammer the DB. */
const presenceThrottle = new Map<string, number>();

/**
 * Record that a user is *present* in a project (authenticated portal activity)
 * and kick a refill so a warm box is ready by the time they hit "send". The
 * presence timestamp gates reconcile: when no user has touched a project within
 * the presence window, its pool is reaped — so we never hold idle boxes 24/7
 * for absent users. Throttled to ~1 DB write per project per minute.
 */
export function notePoolPresence(projectId: string, userId?: string | null): void {
  if (!warmPoolEnabled() || !projectId) return;
  const nowMs = Date.now();
  if (nowMs - (presenceThrottle.get(projectId) ?? 0) < 60_000) return;
  presenceThrottle.set(projectId, nowMs);
  void (async () => {
    try {
      // Record WHO is present (not just when) so the periodic reconcile refills
      // the pool for the actually-active user, matching what claimWarmSandbox
      // will look for — otherwise the sweep would re-warm owner-only boxes.
      const seenAt = sql`jsonb_set(coalesce(${projects.metadata}, '{}'::jsonb), '{warm_pool_seen_at}', to_jsonb(now()))`;
      const meta = userId
        ? sql`jsonb_set(${seenAt}, '{warm_pool_seen_by}', to_jsonb(${userId}::text))`
        : seenAt;
      await db.update(projects).set({ metadata: meta }).where(eq(projects.projectId, projectId));
      await refillProjectPool(projectId, userId);
    } catch (err) {
      console.warn('[warm-pool] notePresence failed:', err instanceof Error ? err.message : err);
    }
  })();
}

/**
 * Periodic reconcile (wired into the project-maintenance sweep). Best-effort,
 * bounded by the global cap:
 *   1. reap dead/aged/marked boxes, AND boxes for projects with no fresh
 *      presence (the user left → stop paying for idle boxes);
 *   2. refill projects where a user is currently present and the pool is enabled.
 */
export async function reconcileWarmPool(now = new Date()): Promise<{ reaped: number; projects: number }> {
  if (!warmPoolEnabled()) return { reaped: 0, projects: 0 };
  let reaped = 0;

  // 0. Sweep errored corpses from failed warm-snapshot creates (the flaky
  //    experimental region fails ~half of creates and the SDK throws without a
  //    box handle, so they linger in `error` state org-side). The opportunistic
  //    reap in createWarm can't keep up on a busy env; this periodic pass keeps
  //    the org converging to clean. Fire-and-forget — never blocks the pool.
  void import('../../snapshots/warm-bake')
    .then(({ reapErroredWarmBoxes }) => reapErroredWarmBoxes(undefined, (l) => console.log(l)))
    .catch(() => {});

  const presenceCutoff = new Date(now.getTime() - config.KORTIX_WARM_POOL_PRESENCE_MINUTES * 60_000);
  const present = await db
    .select({ projectId: projects.projectId, metadata: projects.metadata })
    .from(projects)
    .where(sql`(${projects.metadata} ->> 'warm_pool_seen_at')::timestamptz > ${presenceCutoff.toISOString()}::timestamptz`);
  const presentIds = new Set(present.map((p) => p.projectId));

  // 1. Reap dead/aged/marked boxes + boxes whose project has no fresh presence.
  const poolRows = await db
    .select({ sandboxId: sessionSandboxes.sandboxId, projectId: sessionSandboxes.projectId, externalId: sessionSandboxes.externalId, provider: sessionSandboxes.provider, poolState: sessionSandboxes.poolState, status: sessionSandboxes.status, createdAt: sessionSandboxes.createdAt, updatedAt: sessionSandboxes.updatedAt })
    .from(sessionSandboxes)
    .where(inArray(sessionSandboxes.poolState, ['booting', 'parked', 'reap']));
  for (const row of poolRows) {
    const reason = warmBoxReapReason(row, now.getTime()) ?? (presentIds.has(row.projectId) ? null : 'absent');
    if (reason) {
      await reapWarmSandbox(row);
      reaped++;
      continue;
    }
    if (row.poolState === 'booting' && row.status === 'active' && !resumedPromotions.has(row.sandboxId)) {
      resumedPromotions.add(row.sandboxId);
      void promoteWhenReady(row.sandboxId)
        .catch(() => {})
        .finally(() => resumedPromotions.delete(row.sandboxId));
      console.log(`[warm-pool] resumed promotion ${row.sandboxId.slice(0, 8)}`);
    }
  }

  // 2. Refill projects where a user is present right now and the pool is enabled
  //    (per-project, set from the UI).
  let refilled = 0;
  for (const p of present) {
    if (resolveWarmConfig(p.metadata).enabled) {
      // Warm for the last present user (recorded by notePoolPresence) so the
      // box is claimable by them; fall back to the owner when unknown.
      const seenBy = (p.metadata as Record<string, unknown> | null)?.warm_pool_seen_by;
      await refillProjectPool(p.projectId, typeof seenBy === 'string' ? seenBy : null);
      refilled++;
    }
  }
  return { reaped, projects: refilled };
}

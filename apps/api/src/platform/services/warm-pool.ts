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
 * insert the project_sessions row. Everything is gated behind
 * KORTIX_WARM_POOL_ENABLED (default off).
 */
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { accountMembers, projects, sessionSandboxes } from '@kortix/db';
import { db } from '../../shared/db';
import { config } from '../../config';
import { getProvider } from '../providers';
import { provisionSessionSandbox } from './session-sandbox';

const POOL_BOOT_TIMEOUT_MS = 8 * 60 * 1000; // booting longer than this → failed → reap
const POOL_MAX_AGE_MS = 6 * 60 * 60 * 1000; // parked longer than this → cycle (snapshot drift)
const READY_PROBE_TIMEOUT_MS = 5 * 60 * 1000;
const READY_PROBE_INTERVAL_MS = 3000;

// The operator turns the whole feature on (KORTIX_WARM_POOL_ENABLED) and sets
// the default size (KORTIX_WARM_POOL_SIZE). Within that, each project can opt
// in/out and pick a size from the UI (Customize → Sandbox), stored in
// projects.metadata.warm_pool — DB only, never in kortix.toml.
export const warmPoolEnabled = (): boolean => config.KORTIX_WARM_POOL_ENABLED === true;

const MAX_WARM_SIZE = 10;
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
}): Promise<{ sandboxId: string; externalId: string | null; accountId: string; opencodeSessionId: string | null } | null> {
  if (!warmPoolEnabled()) return null;
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
      ORDER BY (s.pool_state = 'parked') DESC, s.created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING sandbox_id, external_id, account_id, metadata
  `);
  const r = (claimed as unknown as { rows?: any[] }).rows ?? (claimed as unknown as any[]);
  const row = Array.isArray(r) ? r[0] : undefined;
  if (!row) return null;
  const meta = (row.metadata ?? {}) as Record<string, any>;
  return {
    sandboxId: row.sandbox_id as string,
    externalId: (row.external_id ?? null) as string | null,
    accountId: row.account_id as string,
    // Pin pre-warmed at park time (see promoteWhenReady) → claim skips ensure-opencode.
    opencodeSessionId: (meta.warmPool?.opencodeSessionId ?? null) as string | null,
  };
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
}): Promise<boolean> {
  const ownerUserId = await getProjectOwnerUserId(project.accountId);
  if (!ownerUserId || !project.repoUrl) return false;
  const W = randomUUID();
  // Lazy import to avoid a load-time cycle with projects/index.ts.
  const { buildSessionSandboxEnvVars } = await import('../../projects');
  const extraEnvVars = await buildSessionSandboxEnvVars({
    accountId: project.accountId,
    projectId: project.projectId,
    sessionId: W,
    userId: ownerUserId,
    repoUrl: project.repoUrl,
    baseRef: project.defaultBranch,
    agentName: 'default',
    initialPrompt: null,
  });
  await provisionSessionSandbox({
    sandboxId: W,
    accountId: project.accountId,
    projectId: project.projectId,
    userId: ownerUserId,
    extraEnvVars,
    poolState: 'booting',
    metadata: {
      warmPool: {
        ownerUserId,
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
 * Kick a single project's pool toward its desired size (best-effort, fire and
 * forget). Called reactively right after a claim so the pool refills fast.
 */
export async function refillProjectPool(projectId: string): Promise<void> {
  if (!warmPoolEnabled()) return;
  try {
    const [project] = await db
      .select({ projectId: projects.projectId, accountId: projects.accountId, repoUrl: projects.repoUrl, defaultBranch: projects.defaultBranch, manifestPath: projects.manifestPath, metadata: projects.metadata })
      .from(projects)
      .where(eq(projects.projectId, projectId))
      .limit(1);
    if (!project) return;
    const cfg = resolveWarmConfig(project.metadata);
    if (!cfg.enabled || cfg.size <= 0) return;
    const desired = cfg.size;
    const live = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(sessionSandboxes)
      .where(and(eq(sessionSandboxes.projectId, projectId), inArray(sessionSandboxes.poolState, ['booting', 'parked'])))
      .then((rows) => Number(rows[0]?.n ?? 0));
    const globalRemaining = config.KORTIX_WARM_POOL_MAX_TOTAL - (await countGlobalWarm());
    const want = Math.min(desired - live, Math.max(0, globalRemaining));
    for (let i = 0; i < want; i++) {
      await spawnWarmSandbox(project).catch((err) => console.warn('[warm-pool] spawn failed:', err instanceof Error ? err.message : err));
    }
  } catch (err) {
    console.warn('[warm-pool] refill failed:', err instanceof Error ? err.message : err);
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
export function notePoolPresence(projectId: string): void {
  if (!warmPoolEnabled() || !projectId) return;
  const nowMs = Date.now();
  if (nowMs - (presenceThrottle.get(projectId) ?? 0) < 60_000) return;
  presenceThrottle.set(projectId, nowMs);
  void (async () => {
    try {
      await db
        .update(projects)
        .set({ metadata: sql`jsonb_set(coalesce(${projects.metadata}, '{}'::jsonb), '{warm_pool_seen_at}', to_jsonb(now()))` })
        .where(eq(projects.projectId, projectId));
      await refillProjectPool(projectId);
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
    }
  }

  // 2. Refill projects where a user is present right now and the pool is enabled
  //    (per-project, set from the UI).
  let refilled = 0;
  for (const p of present) {
    if (resolveWarmConfig(p.metadata).enabled) {
      await refillProjectPool(p.projectId);
      refilled++;
    }
  }
  return { reaped, projects: refilled };
}

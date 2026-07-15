import { createHmac, timingSafeEqual } from 'node:crypto';
import type { TriggerList } from '@kortix/api-contract';
import { projectSessions, projectTriggerRuntime, projects } from '@kortix/db';
import { Cron } from 'croner';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { config } from '../../config';
import { auth, errors } from '../../openapi';
import { db } from '../../shared/db';
import { isLeader } from '../../shared/leader-election';
import { manifestCandidatePaths } from '@kortix/manifest-schema';
import { commitFileToBranch, invalidateProjectMirror } from '../git';
import { type GitHubAuthContext, commitFile, getFileSha } from '../github';
import {
  continueSession,
  createSession,
  drainSessionLifecycleQueue,
  resolveAgentRunAttribution,
  resolveProjectAutomationActor,
  sessionBackpressureState,
} from '../session-lifecycle';
import {
  type GitTriggerSessionMode,
  type GitTriggerSpec,
  KNOWN_SCHEMA_VERSION,
  MANIFEST_FILENAME,
  type ParsedManifest,
  loadProjectTriggers,
  readManifest,
  serializeManifest,
  triggerSpecToTomlEntry,
} from '../triggers';
import { parseGitHubRepoUrl, resolveProjectGitAuth, withProjectGitAuth } from './git';
import {
  type ProjectRow,
  type RequestAuditContext,
  deriveKortixApiRoot,
  isPlainObject,
  normalizeBoolean,
  normalizeString,
} from './serializers';

export function normalizeSignatureHeader(value: string | null): string | null {
  const header = normalizeString(value);
  if (!header) return null;
  return header.startsWith('sha256=') ? header.slice('sha256='.length) : header;
}

export function verifyWebhookSignature(
  rawBody: string,
  secret: string,
  signatureHeader: string | null,
) {
  const signature = normalizeSignatureHeader(signatureHeader);
  if (!signature || !/^[a-f0-9]{64}$/i.test(signature)) return false;

  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const actualBuffer = Buffer.from(signature, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

// Pull a static shared-secret token from a webhook request's headers, for
// sources that can't HMAC-sign the body (e.g. Better Stack error webhooks, which
// only allow custom headers / basic auth). Order: X-Kortix-Token, then
// Authorization (Bearer <token> or Basic <base64(user:token)> → password).
export function extractWebhookToken(
  kortixToken: string | null | undefined,
  authorization: string | null | undefined,
): string | null {
  if (kortixToken && kortixToken.trim()) return kortixToken.trim();
  if (authorization && authorization.trim()) {
    const trimmed = authorization.trim();
    const sep = trimmed.indexOf(' ');
    const scheme = (sep === -1 ? trimmed : trimmed.slice(0, sep)).toLowerCase();
    const value = sep === -1 ? '' : trimmed.slice(sep + 1).trim();
    if (scheme === 'bearer' && value) return value;
    if (scheme === 'basic' && value) {
      try {
        const decoded = Buffer.from(value, 'base64').toString('utf8');
        const colon = decoded.indexOf(':');
        const password = colon >= 0 ? decoded.slice(colon + 1) : decoded;
        return password || null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

// Static-token fallback auth (only consulted when no HMAC signature header is
// present). The token must equal the trigger's secret; constant-time compared.
export function verifyWebhookToken(token: string | null, secret: string): boolean {
  if (!token) return false;
  const actual = Buffer.from(token);
  const expected = Buffer.from(secret);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export function parseWebhookJsonBody(rawBody: string): unknown {
  if (!rawBody.trim()) return {};
  try {
    return JSON.parse(rawBody);
  } catch {
    return { raw: rawBody };
  }
}

export function valueAtPath(source: unknown, path: string[]): unknown {
  let current = source;
  for (const segment of path) {
    if (!isPlainObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

export function templateValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

export function renderPromptTemplate(template: string, payload: Record<string, unknown>) {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, token: string) => {
    const [root, ...path] = token.split('.');
    if (!root) return '';
    const value = path.length === 0 ? payload[root] : valueAtPath(payload[root], path);
    return templateValue(value);
  });
}

export function webhookPayload(c: Context, rawBody: string) {
  const body = parseWebhookJsonBody(rawBody);
  return {
    body,
    headers: {
      content_type: c.req.header('content-type') ?? null,
      user_agent: c.req.header('user-agent') ?? null,
      forwarded_for: c.req.header('x-forwarded-for') ?? null,
    },
  };
}

export async function triggerBackpressureState(accountId: string, projectId: string) {
  return sessionBackpressureState(accountId, projectId);
}

// POST /v1/webhooks/projects/:projectId/:slug
//
// Public fire endpoint for GIT-BACKED webhook triggers. The trigger config
// lives in `.opencode/triggers/<slug>.md` in the project repo; the signing
// secret lives in `project_secrets` (referenced from the file via
// `secret_env`). On a valid signed POST, we render the prompt template and
// spawn a session — same as the DB-backed `/v1/webhooks/:triggerId` path,
// but the source of truth is git.

export type TriggerSchedulerTimer = ReturnType<typeof setInterval>;

export const globalForProjectTriggers = globalThis as typeof globalThis & {
  __kortixProjectTriggerSchedulerTimer?: TriggerSchedulerTimer | null;
};

export let triggerSchedulerTimer: TriggerSchedulerTimer | null = null;

export let triggerSweepRunning = false;
// When the in-flight sweep started (epoch ms). Used to reclaim a stuck guard if
// a sweep hangs past its hard cap, so a single frozen pass can't wedge the
// scheduler forever (root cause of the 2026-06-21 fleet-wide cron outage).
export let triggerSweepStartedMs = 0;

// In-memory heartbeat for the trigger scheduler, surfaced at /health so an
// operator can tell at a glance whether the leader's sweep is alive and what
// the last pass did. Lives on the leader pod; resets on restart. This is the
// answer to "how would anyone know the scheduler stopped firing?".
export interface TriggerSchedulerHealth {
  lastSweepStartedAt: string | null;
  lastSweepCompletedAt: string | null;
  lastSweepDurationMs: number | null;
  lastResult: {
    scanned: number;
    fired: number;
    queued: number;
    failed: number;
    skipped: number;
  } | null;
  lastError: string | null;
}
const schedulerHealth: TriggerSchedulerHealth = {
  lastSweepStartedAt: null,
  lastSweepCompletedAt: null,
  lastSweepDurationMs: null,
  lastResult: null,
  lastError: null,
};
export function getTriggerSchedulerHealth(): TriggerSchedulerHealth {
  return schedulerHealth;
}

// ─── Reliability: timeouts + stall detection ─────────────────────────────────
// The 2026-06-21 fleet-wide cron outage: one trigger fire (continueSession
// resuming a dead sandbox) hung forever inside a SEQUENTIAL sweep that awaited
// it with no timeout, so the in-flight guard never cleared and EVERY cron
// stopped firing for ~18h with no error. These bounds make a hung/slow fire
// survivable: one trigger can fail, the rest of the fleet still fires, and the
// scheduler can never wedge — no matter what.

/** Hard cap on a single trigger fire (createSession/continueSession). */
export function triggerFireTimeoutMs(): number {
  const raw = Number(process.env.KORTIX_TRIGGER_FIRE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 45_000;
}
/** Hard cap on loading one project's manifest from its git mirror. */
export function triggerLoadTimeoutMs(): number {
  const raw = Number(process.env.KORTIX_TRIGGER_LOAD_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 30_000;
}
/** Hard cap on a whole sweep pass — backstop so nothing can wedge the guard. */
export function triggerSweepTimeoutMs(): number {
  // GENEROUS backstop, not a routine cap. A full sweep loads every active
  // project's manifest sequentially (~1.7k projects → ~11min/pass observed), and
  // the per-fire/per-load timeouts already guarantee no single op hangs forever.
  // A short cap here would GUILLOTINE a legit long sweep and drop cron coverage
  // for projects late in the pass (a 4min cap reached only ~10 of ~39 due
  // triggers). Keep this well above a real sweep so it only fires on a true hang
  // not bounded by the per-op timeouts (e.g. a wedged DB call); tune via env.
  const raw = Number(process.env.KORTIX_TRIGGER_SWEEP_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 20 * 60_000;
}

/**
 * Resolve `p`, or reject once `ms` elapses. The underlying work is NOT
 * cancellable (JS has no promise cancellation), but rejecting lets the caller
 * move on / clear its guard instead of blocking forever on a hung await.
 */
export async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Pure stall check: is the leader's scheduler failing to make progress? Surfaced
 * at /health and used by the in-loop watchdog so a frozen scheduler is loud, not
 * silent. NOT stale when: not leader, the scheduler hasn't ticked yet (grace
 * right after promotion), a sweep completed recently, OR a sweep is in-flight and
 * still within the stale window. Stale only when the latest sweep has been
 * IN-FLIGHT longer than `staleMs`, or the last COMPLETED sweep is older than
 * `staleMs` (the interval died). The in-flight case is why we key off the start
 * time, not a `lastDone=0` sentinel — otherwise a fresh leader's very first
 * (legitimately long) sweep would read as stale the instant it began.
 */
export function isSweepStale(opts: {
  isLeader: boolean;
  lastSweepStartedAt: string | null;
  lastSweepCompletedAt: string | null;
  nowMs: number;
  staleMs: number;
}): boolean {
  if (!opts.isLeader) return false;
  if (!opts.lastSweepStartedAt) return false;
  const startedMs = Date.parse(opts.lastSweepStartedAt);
  const completedMs = opts.lastSweepCompletedAt ? Date.parse(opts.lastSweepCompletedAt) : 0;
  // The latest sweep already completed → healthy unless the NEXT one is overdue.
  if (completedMs >= startedMs) return opts.nowMs - completedMs > opts.staleMs;
  // A sweep is in-flight (started, not yet completed) → stale only if it has been
  // running longer than the stale window.
  return opts.nowMs - startedMs > opts.staleMs;
}

function schedulerStaleMs(): number {
  // Generous: several intervals OR one full sweep-timeout window, whichever is
  // larger, so we never false-alarm on a legitimately long (but completing) pass.
  return Math.max(
    5 * triggerSchedulerIntervalMs(),
    triggerSweepTimeoutMs() + triggerSchedulerIntervalMs(),
  );
}

/** Is the leader's trigger sweep stalled right now? (Wraps the pure check.) */
export function schedulerSweepIsStale(isLeaderNow: boolean, nowMs: number = Date.now()): boolean {
  return isSweepStale({
    isLeader: isLeaderNow,
    lastSweepStartedAt: schedulerHealth.lastSweepStartedAt,
    lastSweepCompletedAt: schedulerHealth.lastSweepCompletedAt,
    nowMs,
    staleMs: schedulerStaleMs(),
  });
}

// Connector reconcile sweep — runs on a slower cadence than the trigger sweep.

export let connectorSweepRunning = false;

export let lastConnectorSweepAt = 0;

export function connectorSweepIntervalMs() {
  const raw = Number(process.env.KORTIX_CONNECTOR_SWEEP_INTERVAL_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 120_000;
}

export function triggerSchedulerIntervalMs() {
  const raw = Number((config as any).KORTIX_TRIGGER_SCHEDULER_INTERVAL_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 60_000;
}

export function nextCronRun(schedule: string, from: Date, timezone?: string): Date | null {
  const job = new Cron(schedule, { paused: true, ...(timezone ? { timezone } : {}) });
  return job.nextRun(from);
}

/**
 * Server-side, per-project trigger kill-switch (`projects.metadata.triggers_paused`).
 * When paused, the platform does NOT auto-run any of the project's triggers —
 * the cron sweep skips it and inbound webhooks are ignored — even though each
 * trigger is still `enabled` in the repo. This is how you stop ONE repo
 * deployed to TWO independent control planes (e.g. dev.kortix.com + kortix.com,
 * separate DBs/schedulers with no cross-platform dedup) from double-firing every
 * cron: pause it on the deployment you don't want firing. A manual
 * `…/triggers/:slug/fire` is an explicit action and still runs. Toggle via
 * `PATCH /:projectId/triggers/activation`.
 */
export function triggersPausedForProject(metadata: unknown): boolean {
  return isPlainObject(metadata) && (metadata as Record<string, unknown>).triggers_paused === true;
}

export function withTriggersPaused(metadata: unknown, paused: boolean): Record<string, unknown> {
  const base = isPlainObject(metadata) ? { ...(metadata as Record<string, unknown>) } : {};
  if (paused) base.triggers_paused = true;
  else delete base.triggers_paused;
  return base;
}

/**
 * Walks every active project's git repo for `.opencode/triggers/*.md` and
 * fires due cron triggers. Triggers are 100% file-defined now (kortix.yaml,
 * or kortix.toml for a legacy v1 project); the old DB-backed trigger tables
 * have been removed.
 */

export async function runProjectTriggerSweep(now = new Date()): Promise<{
  scanned: number;
  fired: number;
  queued: number;
  failed: number;
  skipped: number;
}> {
  // In-flight guard with SELF-HEAL: a sweep that hangs past the hard cap must
  // not freeze the scheduler forever. If the guard is held but the running sweep
  // is older than its timeout, reclaim it so this tick starts a fresh pass.
  if (triggerSweepRunning) {
    if (Date.now() - triggerSweepStartedMs < triggerSweepTimeoutMs()) {
      return { scanned: 0, fired: 0, queued: 0, failed: 0, skipped: 0 };
    }
    console.error(
      `[project-triggers] reclaiming stuck sweep guard — previous sweep exceeded ${triggerSweepTimeoutMs()}ms without completing (self-heal)`,
    );
  }
  triggerSweepRunning = true;
  const startedMs = Date.now();
  triggerSweepStartedMs = startedMs;
  schedulerHealth.lastSweepStartedAt = now.toISOString();
  const result = { scanned: 0, fired: 0, queued: 0, failed: 0, skipped: 0 };
  try {
    // Overall hard cap so a hang anywhere (project scan, mirror load, fire) can
    // never block the guard indefinitely. The per-item timeouts inside the sweep
    // keep one bad project/trigger from starving the rest within a single pass.
    await withTimeout(
      runGitTriggerSweep(now, result),
      triggerSweepTimeoutMs(),
      'project trigger sweep',
    );
    schedulerHealth.lastError = null;
    return result;
  } catch (err) {
    schedulerHealth.lastError = err instanceof Error ? err.message : String(err);
    console.error('[project-triggers/git] sweep failed', err);
    return result;
  } finally {
    schedulerHealth.lastSweepCompletedAt = new Date().toISOString();
    schedulerHealth.lastSweepDurationMs = Date.now() - startedMs;
    schedulerHealth.lastResult = result;
    triggerSweepRunning = false;
  }
}

/**
 * Reconcile every active project's connector DB cache against its kortix.yaml.
 * This is the reliability backstop for connectors: the UI CRUD path and the
 * CR-merge hook reconcile inline, but a raw `git push` / `kortix` CLI edit that
 * bypasses both is only caught here. We invalidate the git mirror per project
 * so an out-of-band manifest edit is seen this sweep (not up to a minute later,
 * behind the mirror refresh throttle). `syncProjectConnectors` is hash-aware,
 * so unchanged connectors cost a manifest read, not a catalog re-fetch.
 */

/**
 * Page through EVERY active project. The sweeps used to `LIMIT 200`, which
 * silently dropped every active project past the 200th once the platform grew
 * beyond that many — their triggers / connectors just never ran, with no error
 * and no log. Paging keeps coverage complete while bounding each query.
 */
async function selectActiveProjects(pageSize = 500): Promise<ProjectRow[]> {
  const all: ProjectRow[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const batch = await db
      .select()
      .from(projects)
      .where(eq(projects.status, 'active'))
      .orderBy(projects.projectId)
      .limit(pageSize)
      .offset(offset);
    all.push(...batch);
    if (batch.length < pageSize) break;
  }
  return all;
}

export async function runProjectConnectorSweep(): Promise<{
  scanned: number;
  synced: number;
  errors: number;
}> {
  if (connectorSweepRunning) return { scanned: 0, synced: 0, errors: 0 };
  connectorSweepRunning = true;
  const out = { scanned: 0, synced: 0, errors: 0 };
  try {
    const { syncProjectConnectors } = await import('../../executor/sync');
    const projectsForSweep = await selectActiveProjects();
    for (const project of projectsForSweep) {
      out.scanned += 1;
      try {
        invalidateProjectMirror(project.projectId);
        const res = await syncProjectConnectors(project.projectId, project.accountId);
        out.synced += res.synced;
        out.errors += res.errors.length;
      } catch (err) {
        out.errors += 1;
        console.warn(
          '[project-connectors] sweep failed',
          project.projectId,
          err instanceof Error ? err.message : err,
        );
      }
    }
    return out;
  } finally {
    connectorSweepRunning = false;
  }
}

// ─── Git-backed triggers ────────────────────────────────────────────────────
//
// Triggers can ALSO live in the project repo at `.opencode/triggers/<slug>.md`
// — see ./triggers.ts for the file format. The repo is the source of truth
// for config (cron expr, prompt, secret_env reference). Runtime state
// (last_fired_at) lives in `project_trigger_runtime` because writing the
// repo on every fire would amplify a 5s scheduler tick into a flood of
// git commits.

/**
 * Find a user we can attribute trigger-spawned sessions to. Git-backed
 * triggers don't have a `created_by` like the DB-backed ones do — we pick
 * the account's first owner as a stable, audit-friendly stand-in.
 */

export async function resolveGitTriggerActor(accountId: string): Promise<string | null> {
  return resolveProjectAutomationActor(accountId);
}

/**
 * Resolve the identity a trigger's automated session PROVISIONS as — the
 * account-member stand-in `createProjectSession` needs for the provisioning/
 * authorization actor (concurrency cap, secret-visibility subject, the
 * standing-role fallback an unactivated agent SA relies on — see
 * `resolveActingActor` in iam/engine-v2.ts). This is intentionally NOT the
 * run's recorded identity: see `attributeFiredTriggerSession` below, which
 * overwrites `project_sessions.created_by` to the agent's own service account
 * right after the row exists — "attribution and authorization stop sharing
 * one field" (docs/specs/2026-07-05-agent-first-config-unification.md §2.2).
 * What a run can actually ACCESS is governed by the AGENT's declared scope in
 * kortix.yaml's `agents:` map (secrets + connectors), applied when the session
 * env is built — not by this stand-in.
 */
export async function resolveTriggerActor(project: ProjectRow): Promise<string | null> {
  return resolveProjectAutomationActor(project.accountId);
}

/**
 * Re-attribute a freshly created trigger-fired session to the firing agent's
 * standing-identity service account: `created_by` (session identity/audit —
 * NOT the visibility gate, which is `visibility: 'project'` for every trigger
 * session regardless of owner) moves off the arbitrary account-owner stand-in
 * `resolveTriggerActor` returns and onto the agent itself. Closes the TODO
 * that lived here: "resolve to the agent's SERVICE ACCOUNT so per-user
 * connectors + secrets bind to the AGENT itself, with no human userId at all."
 *
 * Deliberately a POST-creation fixup rather than changing what `fireGitTrigger`
 * passes as `userId` into `createSession`: that value also drives provisioning
 * (concurrency cap, secret-share subject) and is the fallback identity IAM
 * v2 authorizes as when the agent's SA has no role bound yet (unactivated —
 * the default state for an auto-provisioned agent). Swapping it for the SA
 * there would make every un-activated trigger agent authorize as a bare,
 * role-less service account and lose that fallback outright — see
 * `resolveActingActor` in iam/engine-v2.ts. The authorization path stays
 * exactly as it is today; only the audit-facing owner changes.
 *
 * Best-effort: failures are logged and swallowed — a session that already
 * fired must not be reported as failed over a cosmetic attribution miss.
 * No-op for the `session_mode = "reuse"` path (the reused session's
 * `created_by` was already fixed up the first time it was created).
 */
export async function attributeFiredTriggerSession(input: {
  project: ProjectRow;
  sessionId: string;
  agentName: string;
}): Promise<void> {
  const serviceAccountId = await resolveAgentRunAttribution({
    accountId: input.project.accountId,
    projectId: input.project.projectId,
    agentName: input.agentName,
  });
  if (!serviceAccountId) return;
  try {
    await db
      .update(projectSessions)
      .set({ createdBy: serviceAccountId })
      .where(eq(projectSessions.sessionId, input.sessionId));
  } catch (err) {
    console.warn('[triggers] failed to attribute fired session to agent service account', {
      sessionId: input.sessionId,
      agentName: input.agentName,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function isGitCronSpecDue(
  spec: GitTriggerSpec,
  lastFiredAt: Date | null,
  now: Date,
): boolean {
  // One-off ("run once") schedules: fire exactly once at/after `runAt`. The
  // last_fired_at stamp written on the first fire keeps it dormant forever
  // after — no cron, no self-disable needed.
  if (spec.runAt) {
    if (lastFiredAt) return false;
    const at = Date.parse(spec.runAt);
    return !Number.isNaN(at) && at <= now.getTime();
  }
  if (!spec.cron) return false;
  try {
    const baseline = lastFiredAt ?? new Date(0);
    const next = nextCronRun(spec.cron, baseline, spec.timezone);
    return Boolean(next && next.getTime() <= now.getTime());
  } catch {
    return false;
  }
}

export async function getGitTriggerRuntime(projectId: string, slug: string) {
  const [row] = await db
    .select()
    .from(projectTriggerRuntime)
    .where(
      and(eq(projectTriggerRuntime.projectId, projectId), eq(projectTriggerRuntime.slug, slug)),
    )
    .limit(1);
  return row ?? null;
}

export async function markGitTriggerFired(
  projectId: string,
  slug: string,
  when: Date,
  status: 'fired' | 'queued' = 'fired',
) {
  await db
    .insert(projectTriggerRuntime)
    .values({
      projectId,
      slug,
      lastFiredAt: when,
      lastStatus: status,
      lastError: null,
      lastAttemptAt: when,
      updatedAt: when,
    })
    .onConflictDoUpdate({
      target: [projectTriggerRuntime.projectId, projectTriggerRuntime.slug],
      set: {
        lastFiredAt: when,
        lastStatus: status,
        lastError: null,
        lastAttemptAt: when,
        updatedAt: when,
      },
    });
}

/**
 * Record a failed attempt (fire error or parse error) WITHOUT advancing
 * `last_fired_at`, so the trigger is still due and retries next sweep — but the
 * reason is now visible in the triggers API/UI instead of vanishing into a log.
 */
export async function markGitTriggerAttemptFailed(
  projectId: string,
  slug: string,
  when: Date,
  error: string,
) {
  const lastError = error.slice(0, 1000);
  await db
    .insert(projectTriggerRuntime)
    .values({
      projectId,
      slug,
      lastStatus: 'failed',
      lastError,
      lastAttemptAt: when,
      updatedAt: when,
    })
    .onConflictDoUpdate({
      target: [projectTriggerRuntime.projectId, projectTriggerRuntime.slug],
      set: { lastStatus: 'failed', lastError, lastAttemptAt: when, updatedAt: when },
    });
}

/**
 * Find the canonical session to reuse for a `session_mode = "reuse"` trigger:
 * the most recent NON-failed session this trigger created. Sessions are matched
 * via the `trigger_slug` + `trigger_kind` we stamp into `project_sessions.metadata`
 * at fire time (no extra column / migration needed). Failed sessions are skipped
 * so a dead run is abandoned in favor of a freshly-created canonical session.
 */
export async function findReusableTriggerSession(
  projectId: string,
  slug: string,
): Promise<{ sessionId: string } | null> {
  const [row] = await db
    .select({ sessionId: projectSessions.sessionId })
    .from(projectSessions)
    .where(
      and(
        eq(projectSessions.projectId, projectId),
        ne(projectSessions.status, 'failed'),
        sql`${projectSessions.metadata} ->> 'trigger_slug' = ${slug}`,
        sql`${projectSessions.metadata} ->> 'trigger_kind' = 'git'`,
      ),
    )
    .orderBy(desc(projectSessions.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * Fire a git-backed trigger. Triggers are file-defined (kortix.yaml), so there
 * is no DB trigger/event row — the project_sessions row carries `trigger_slug`
 * in metadata so audits can still reconstruct the firing path.
 */

export async function fireGitTrigger(input: {
  spec: GitTriggerSpec;
  project: ProjectRow;
  payload: Record<string, unknown>;
  renderedPrompt: string;
  source: 'cron' | 'webhook' | 'manual';
  idempotencyKey?: string | null;
  request?: RequestAuditContext;
}): Promise<{
  status: 'fired' | 'queued' | 'failed';
  sessionId?: string;
  commandId?: string;
  error?: string;
  reason?: string;
  deduped?: boolean;
}> {
  const { spec, project, payload, renderedPrompt, source } = input;
  // The session's owning identity (created_by / billing / audit). Automated runs
  // never impersonate a picked human — the agent's declared scope governs access.
  // See resolveTriggerActor().
  const actor = await resolveTriggerActor(project);
  if (!actor) {
    return { status: 'failed', error: 'No account owner available to own the session' };
  }

  // Session pinning — when a trigger opts into `session_mode = "pinned"`, always
  // re-prompt the EXACT session the user chose (`spec.pinnedSessionId`), not
  // "whatever this trigger last created" (that's `reuse`). If the pinned session
  // is gone/unresumable we degrade gracefully: fall through to the `reuse` block
  // (the trigger's own last session), then to a brand-new session.
  if (spec.sessionMode === 'pinned' && spec.pinnedSessionId) {
    const outcome = await continueSession({
      source: `trigger:${source}`,
      sessionId: spec.pinnedSessionId,
      text: renderedPrompt,
      userId: actor,
    });
    if (outcome === 'delivered') {
      return { status: 'fired', sessionId: spec.pinnedSessionId };
    }
    if (outcome === 'pending') {
      return {
        status: 'queued',
        sessionId: spec.pinnedSessionId,
        reason: 'pinned session resuming',
      };
    }
    // outcome === 'no-session' | 'failed' → pinned session is gone/unusable;
    // fall through to the reuse/create fallback below.
  }

  // Session reuse — when a trigger opts into `session_mode = "reuse"`, re-prompt
  // the canonical session this trigger already created (resuming its sandbox +
  // opencode root) so ONE long-lived session accumulates context across fires,
  // instead of minting a brand-new session every time. If no reusable session
  // exists yet, or the last one is gone/failed, we fall through to createSession
  // below and that fresh session becomes the canonical one for next time. Also
  // the graceful-degradation path for a `pinned` trigger whose pin is dead.
  if (spec.sessionMode === 'reuse' || spec.sessionMode === 'pinned') {
    const reusable = await findReusableTriggerSession(project.projectId, spec.slug);
    if (reusable) {
      const outcome = await continueSession({
        source: `trigger:${source}`,
        sessionId: reusable.sessionId,
        text: renderedPrompt,
        userId: actor,
      });
      if (outcome === 'delivered') {
        return { status: 'fired', sessionId: reusable.sessionId };
      }
      if (outcome === 'pending') {
        // Runtime still spinning up (e.g. resuming an archived sandbox). The
        // prompt will land once it's ready — treat as a successful fire so the
        // scheduler records last_fired_at and doesn't immediately create a dupe.
        return { status: 'queued', sessionId: reusable.sessionId, reason: 'session resuming' };
      }
      // outcome === 'no-session' | 'failed' → canonical session is unusable;
      // fall through to create a fresh one below.
    }
  }

  const sessionResult = await createSession({
    source: `trigger:${source}`,
    project,
    userId: actor,
    enforceAccountCap: false,
    // Trigger sessions are project automation, not the actor's personal chat —
    // make them project-visible so the whole team can find them.
    visibility: 'project',
    request: input.request,
    queuePolicy: 'on_backpressure',
    idempotencyKey: input.idempotencyKey ?? null,
    body: {
      agent_name: spec.agent,
      initial_prompt: renderedPrompt,
      // A trigger-level model pins this run's session to that model, taking
      // precedence over the agent/account/platform default chain. Omitted
      // (null) leaves resolution to that chain — see GitTriggerSpec.model.
      ...(spec.model ? { opencode_model: spec.model } : {}),
      metadata: {
        trigger_source: source,
        trigger_kind: 'git',
        trigger_slug: spec.slug,
        trigger_type: spec.type,
      },
    },
    metadata: {
      trigger_source: source,
      trigger_kind: 'git',
      trigger_slug: spec.slug,
      trigger_type: spec.type,
      payload_summary: summarizeTriggerPayload(payload),
    },
  });

  if (sessionResult.status === 'queued' || sessionResult.status === 'pending') {
    return {
      status: 'queued',
      commandId: sessionResult.commandId,
      sessionId: sessionResult.sessionId,
      reason: sessionResult.reason,
      deduped: sessionResult.deduped,
    };
  }
  if (sessionResult.error) {
    return {
      status: 'failed',
      error: String(sessionResult.error.body.error ?? 'Failed to create trigger session'),
    };
  }
  const firedSessionId = sessionResult.sessionId ?? sessionResult.row?.sessionId;
  // Re-attribute the run to the agent's own service account (see
  // attributeFiredTriggerSession's docblock). `row.agentName` is the RESOLVED
  // name `createProjectSession` actually persisted (default-sentinel/
  // project-default fallbacks already applied) — using it here means this
  // never re-derives that resolution logic. Best-effort: this must not turn an
  // already-fired session into a failed trigger result.
  if (firedSessionId && sessionResult.row?.agentName) {
    await attributeFiredTriggerSession({
      project,
      sessionId: firedSessionId,
      agentName: sessionResult.row.agentName,
    }).catch(() => {});
  }
  return {
    status: 'fired',
    sessionId: firedSessionId,
    commandId: sessionResult.commandId,
    deduped: sessionResult.deduped,
  };
}

export function summarizeTriggerPayload(payload: Record<string, unknown>): Record<string, unknown> {
  // Strip the rendered body from session metadata — sessions already get the
  // prompt as KORTIX_INITIAL_PROMPT, and we don't want huge payloads in
  // postgres jsonb.
  const { rendered_body: _r, ...rest } = payload as Record<string, unknown>;
  return rest;
}

/**
 * Walk all active projects, load their git-backed triggers, and fire any
 * cron triggers that are due. Runtime state (last_fired_at) lives in
 * `project_trigger_runtime`, keyed by project + slug.
 *
 * We swallow per-project errors so one busted repo can't break the sweep
 * for everyone else.
 */

export async function runGitTriggerSweep(
  now: Date,
  accumulator: {
    scanned: number;
    fired: number;
    queued: number;
    failed: number;
    skipped: number;
  },
): Promise<void> {
  const projectsForSweep = await selectActiveProjects();

  for (const project of projectsForSweep) {
    // Server-side per-project kill-switch — skip the whole project (no manifest
    // read, no session spin) when its triggers are paused, so a repo deployed
    // to two control planes only fires on the un-paused one. See
    // triggersPausedForProject.
    if (triggersPausedForProject(project.metadata)) continue;
    let specs: GitTriggerSpec[];
    try {
      // Time-bound the mirror load: a hung clone/fetch for one project must not
      // stall the sweep for everyone else.
      const loaded = await withTimeout(
        loadProjectTriggers(await withProjectGitAuth(project)),
        triggerLoadTimeoutMs(),
        `load triggers ${project.projectId}`,
      );
      specs = loaded.specs;
      // Surface parse errors instead of dropping them: record each bad entry
      // against its slug so it shows up in the triggers API/UI, and log it.
      // Previously a malformed `[[triggers]]` entry just vanished from the
      // sweep with zero feedback — a prime "my trigger isn't running" trap.
      for (const e of loaded.errors) {
        console.warn('[project-triggers/git] parse error', project.projectId, e.slug, e.error);
        await markGitTriggerAttemptFailed(
          project.projectId,
          e.slug,
          now,
          `parse error: ${e.error}`,
        );
      }
    } catch (err) {
      console.warn(
        '[project-triggers/git] load failed',
        project.projectId,
        err instanceof Error ? err.message : err,
      );
      continue;
    }

    for (const spec of specs) {
      if (spec.type !== 'cron' || !spec.enabled) continue;
      accumulator.scanned += 1;

      const runtime = await getGitTriggerRuntime(project.projectId, spec.slug);
      const lastFired = runtime?.lastFiredAt ?? null;
      if (!isGitCronSpecDue(spec, lastFired, now)) {
        accumulator.skipped += 1;
        continue;
      }

      const payload = {
        cron: {
          schedule: spec.cron ?? spec.runAt,
          timezone: spec.timezone,
          fired_at: now.toISOString(),
          last_fired_at: lastFired?.toISOString() ?? null,
        },
        trigger: { slug: spec.slug, type: spec.type, kind: 'git' },
      };
      const renderedPrompt = renderPromptTemplate(spec.promptTemplate, payload);
      const scheduledAt = now.toISOString();
      // Stable idempotency key per DUE SLOT (the cron boundary that made this
      // trigger due), not per sweep tick — so a fire we timed out on but that
      // actually lands late isn't duplicated when the next tick retries.
      const dueSlotKey =
        (spec.cron
          ? nextCronRun(spec.cron, lastFired ?? new Date(0), spec.timezone)?.toISOString()
          : spec.runAt) ?? scheduledAt;

      let result: Awaited<ReturnType<typeof fireGitTrigger>>;
      try {
        // Time-bound the fire (createSession/continueSession). A hung or throwing
        // fire must NOT abort the sweep or wedge the scheduler: record it
        // (diagnosable, retries next tick) and move on to the next trigger.
        result = await withTimeout(
          fireGitTrigger({
            spec,
            project,
            payload,
            renderedPrompt,
            source: 'cron',
            idempotencyKey: `trigger:cron:${project.projectId}:${spec.slug}:${dueSlotKey}`,
          }),
          triggerFireTimeoutMs(),
          `fire ${spec.slug} ${project.projectId}`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[project-triggers/git] fire errored', project.projectId, spec.slug, msg);
        await markGitTriggerAttemptFailed(project.projectId, spec.slug, now, msg).catch(() => {});
        accumulator.failed += 1;
        continue;
      }
      if (result.status === 'fired') {
        await markGitTriggerFired(project.projectId, spec.slug, now, 'fired');
        accumulator.fired += 1;
      } else if (result.status === 'queued') {
        await markGitTriggerFired(project.projectId, spec.slug, now, 'queued');
        accumulator.queued += 1;
      } else {
        // A failed fire is NOT stamped as fired, so it retries next tick — but
        // we record why so "trigger isn't running" is diagnosable from the API.
        await markGitTriggerAttemptFailed(
          project.projectId,
          spec.slug,
          now,
          result.error ?? result.reason ?? 'trigger fire failed',
        );
        accumulator.failed += 1;
      }
    }
  }
}

export function startProjectTriggerScheduler(): void {
  if ((config as any).KORTIX_TRIGGER_SCHEDULER_ENABLED === false) return;
  if (globalForProjectTriggers.__kortixProjectTriggerSchedulerTimer) {
    clearInterval(globalForProjectTriggers.__kortixProjectTriggerSchedulerTimer);
  }
  triggerSchedulerTimer = setInterval(() => {
    // Watchdog: if we're the leader but the sweep has stalled (started and never
    // completed within the stale window), make it LOUD. A silent dead scheduler
    // is what turned a single hung fire into an ~18h fleet-wide outage. The
    // self-heal guard in runProjectTriggerSweep reclaims the stuck sweep on this
    // same tick; this console.error is the alert signal for log-based monitoring.
    if (schedulerSweepIsStale(isLeader())) {
      console.error(
        '[project-triggers] SCHEDULER STALLED — leader but last sweep has not completed',
        {
          lastSweepStartedAt: schedulerHealth.lastSweepStartedAt,
          lastSweepCompletedAt: schedulerHealth.lastSweepCompletedAt,
        },
      );
    }

    drainSessionLifecycleQueue({ limit: 10 })
      .then((result) => {
        if (result.claimed || result.failed) {
          console.log('[session-lifecycle] queue drain completed', result);
        }
      })
      .catch((error) => {
        console.error('[session-lifecycle] queue drain failed:', error);
      });

    runProjectTriggerSweep()
      .then((result) => {
        if (result.fired || result.queued || result.failed) {
          console.log('[project-triggers] sweep completed', result);
        }
      })
      .catch((error) => {
        console.error('[project-triggers] sweep failed:', error);
      });

    // Connector reconcile backstop — slower cadence than the trigger sweep so
    // we don't re-read every manifest each tick. Catches out-of-band manifest
    // edits (raw git push / CLI) and heals any DB drift / retries error rows.
    if (Date.now() - lastConnectorSweepAt >= connectorSweepIntervalMs()) {
      lastConnectorSweepAt = Date.now();
      runProjectConnectorSweep()
        .then((result) => {
          if (result.synced || result.errors) {
            console.log('[project-connectors] sweep completed', result);
          }
        })
        .catch((error) => {
          console.error('[project-connectors] sweep failed:', error);
        });
    }
  }, triggerSchedulerIntervalMs());
  globalForProjectTriggers.__kortixProjectTriggerSchedulerTimer = triggerSchedulerTimer;
}

export function stopProjectTriggerScheduler(): void {
  if (triggerSchedulerTimer) {
    clearInterval(triggerSchedulerTimer);
    triggerSchedulerTimer = null;
  }
  if (globalForProjectTriggers.__kortixProjectTriggerSchedulerTimer) {
    clearInterval(globalForProjectTriggers.__kortixProjectTriggerSchedulerTimer);
    globalForProjectTriggers.__kortixProjectTriggerSchedulerTimer = null;
  }
}

// GET /v1/projects

export function buildPublicWebhookUrl(projectId: string, slug: string): string {
  const root = deriveKortixApiRoot(config.KORTIX_URL);
  return `${root}/v1/webhooks/projects/${projectId}/${slug}`;
}

// ── Git-backed trigger CRUD helpers ─────────────────────────────────────────

/** Builds the GET-listing response shape (specs + runtime + errors). */

export async function loadTriggersForResponse(
  projectId: string,
  project: ProjectRow,
): Promise<TriggerList> {
  const { specs, errors } = await loadProjectTriggers(await withProjectGitAuth(project));
  const runtimeRows =
    specs.length === 0
      ? []
      : await db
          .select()
          .from(projectTriggerRuntime)
          .where(eq(projectTriggerRuntime.projectId, projectId));
  const runtimeBySlug = new Map(runtimeRows.map((row) => [row.slug, row]));

  return {
    triggers: specs.map((spec) => ({
      slug: spec.slug,
      path: spec.path,
      name: spec.name,
      type: spec.type,
      agent: spec.agent,
      model: spec.model,
      enabled: spec.enabled,
      cron: spec.cron,
      run_at: spec.runAt,
      timezone: spec.timezone,
      secret_env: spec.secretEnv,
      prompt_template: spec.promptTemplate,
      session_mode: spec.sessionMode,
      session_id: spec.pinnedSessionId,
      last_fired_at: runtimeBySlug.get(spec.slug)?.lastFiredAt?.toISOString() ?? null,
      last_status: runtimeBySlug.get(spec.slug)?.lastStatus ?? null,
      last_error: runtimeBySlug.get(spec.slug)?.lastError ?? null,
      last_attempt_at: runtimeBySlug.get(spec.slug)?.lastAttemptAt?.toISOString() ?? null,
      webhook_url: spec.type === 'webhook' ? buildPublicWebhookUrl(projectId, spec.slug) : null,
    })),
    // Server-side activation state for this project's whole trigger set. When
    // true, the platform won't auto-run any of them (cron sweep skips, webhooks
    // ignored), regardless of each trigger's own `enabled`.
    triggers_paused: triggersPausedForProject(project.metadata),
    errors,
  };
}

export interface TriggerDraft {
  slug: string;
  name: string;
  type: 'cron' | 'webhook';
  agent: string;
  /** Wire-form model (`provider/model`) or null for "Default" (resolve at fire time). */
  model: string | null;
  enabled: boolean;
  promptTemplate: string;
  cron: string | null;
  runAt: string | null;
  timezone: string;
  secretEnv: string | null;
  sessionMode: GitTriggerSessionMode;
  /** For sessionMode === 'pinned' only: the exact session id to loop. */
  pinnedSessionId: string | null;
}

export function parseTriggerDraft(
  body: Record<string, unknown>,
  opts: { existingSlug: string | null },
): TriggerDraft | { error: string } {
  const rawSlug = normalizeString((body as any).slug);
  const name = normalizeString((body as any).name);
  if (!name) return { error: 'name is required' };

  const slug = opts.existingSlug ?? rawSlug ?? slugify(name);
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(slug)) {
    return { error: `Invalid slug "${slug}" — use letters, digits, dashes, underscores only` };
  }

  const type =
    (body as any).type === 'webhook' ? 'webhook' : (body as any).type === 'cron' ? 'cron' : null;
  if (!type) return { error: 'type must be "cron" or "webhook"' };

  const promptTemplate = normalizeString(
    (body as any).prompt_template ?? (body as any).promptTemplate,
  );
  if (!promptTemplate) return { error: 'prompt_template is required' };

  const agent = normalizeString((body as any).agent ?? (body as any).agent_name) ?? 'default';
  // null/empty model = "Default" — leave it to the resolution chain at fire time.
  const model = normalizeString((body as any).model) ?? null;
  const enabled = normalizeBoolean((body as any).enabled) ?? true;

  const sessionModeRaw = normalizeString((body as any).session_mode ?? (body as any).sessionMode);
  if (
    sessionModeRaw &&
    sessionModeRaw !== 'fresh' &&
    sessionModeRaw !== 'reuse' &&
    sessionModeRaw !== 'pinned'
  ) {
    return { error: 'session_mode must be "fresh", "reuse", or "pinned"' };
  }
  const sessionMode: GitTriggerSessionMode =
    sessionModeRaw === 'reuse' ? 'reuse' : sessionModeRaw === 'pinned' ? 'pinned' : 'fresh';
  const pinnedSessionIdRaw = normalizeString((body as any).session_id ?? (body as any).sessionId);
  if (sessionMode === 'pinned' && !pinnedSessionIdRaw) {
    return { error: 'session_mode "pinned" requires a session_id to pin the trigger to' };
  }
  const pinnedSessionId: string | null =
    sessionMode === 'pinned' ? (pinnedSessionIdRaw ?? null) : null;

  if (type === 'cron') {
    const timezone = normalizeString((body as any).timezone) ?? 'UTC';
    // One-off ("run once") schedules carry `run_at` instead of `cron`.
    const runAtRaw = normalizeString((body as any).run_at ?? (body as any).runAt);
    if (runAtRaw) {
      const parsed = Date.parse(runAtRaw);
      if (Number.isNaN(parsed)) {
        return { error: `run_at must be an ISO-8601 datetime (got "${runAtRaw}")` };
      }
      return {
        slug,
        name,
        type: 'cron',
        agent,
        model,
        enabled,
        promptTemplate,
        cron: null,
        runAt: new Date(parsed).toISOString(),
        timezone,
        secretEnv: null,
        sessionMode,
        pinnedSessionId,
      };
    }
    const cron = normalizeString((body as any).cron ?? (body as any).schedule);
    if (!cron)
      return { error: 'cron triggers must declare a `cron` expression or a one-off `run_at`' };
    return {
      slug,
      name,
      type: 'cron',
      agent,
      model,
      enabled,
      promptTemplate,
      cron,
      runAt: null,
      timezone,
      secretEnv: null,
      sessionMode,
      pinnedSessionId,
    };
  }

  const secretEnv = normalizeString((body as any).secret_env ?? (body as any).secretEnv);
  if (!secretEnv) return { error: 'webhook triggers must declare `secret_env`' };
  if (!/^[A-Z_][A-Z0-9_]*$/.test(secretEnv)) {
    return { error: `secret_env must look like a project_secrets name (got "${secretEnv}")` };
  }
  return {
    slug,
    name,
    type: 'webhook',
    agent,
    model,
    enabled,
    promptTemplate,
    cron: null,
    runAt: null,
    timezone: 'UTC',
    secretEnv,
    sessionMode,
    pinnedSessionId,
  };
}

/** Convert an existing spec back to body shape so we can splat it into a
 * PATCH merge before re-parsing. */

export function specToBody(spec: GitTriggerSpec): Record<string, unknown> {
  return {
    slug: spec.slug,
    name: spec.name,
    type: spec.type,
    agent: spec.agent,
    model: spec.model,
    enabled: spec.enabled,
    prompt_template: spec.promptTemplate,
    cron: spec.cron,
    timezone: spec.timezone,
    secret_env: spec.secretEnv,
    session_mode: spec.sessionMode,
    session_id: spec.pinnedSessionId,
  };
}

export function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-{2,}/g, '-')
      .slice(0, 128) || 'trigger'
  );
}

export function draftToSpec(draft: TriggerDraft, manifestPath: string = MANIFEST_FILENAME): GitTriggerSpec {
  return {
    slug: draft.slug,
    // Use the ACTUAL manifest path so a YAML project's trigger spec reports
    // `kortix.yaml#triggers.<slug>`, not a hardcoded `kortix.toml#…`.
    path: `${manifestPath}#triggers.${draft.slug}`,
    name: draft.name,
    type: draft.type,
    agent: draft.agent,
    model: draft.model,
    enabled: draft.enabled,
    promptTemplate: draft.promptTemplate,
    cron: draft.cron,
    runAt: draft.runAt,
    timezone: draft.timezone,
    secretEnv: draft.secretEnv,
    sessionMode: draft.sessionMode,
    pinnedSessionId: draft.pinnedSessionId,
  };
}

/**
 * Read the project's manifest. If the manifest doesn't exist yet (brand-new
 * repo), synthesize a minimal valid one so the first POST /triggers can
 * scaffold it on save.
 */

export async function loadManifestForEdit(project: ProjectRow): Promise<ParsedManifest> {
  const existing = await readManifest(await withProjectGitAuth(project));
  if (existing) return existing;
  // No manifest yet → synthesize a minimal one. Brand-new repos scaffold
  // kortix.yaml (matching the CLI scaffold); resolve the yaml sibling of
  // whatever manifestPath is configured (defaults to `kortix`'s stem) rather
  // than trusting a stale/legacy `.toml` value literally, so format and path
  // stay in sync on commit.
  return {
    schemaVersion: KNOWN_SCHEMA_VERSION,
    raw: {
      project: { name: project.name, description: '' },
      runtime: { root: '.opencode' },
      env: { required: [], optional: [] },
    },
    format: 'yaml',
    path: manifestCandidatePaths(project.manifestPath)[0].path,
  };
}

/** Insert or replace a trigger by slug inside the manifest's triggers array. */

export function upsertTriggerInManifest(
  manifest: ParsedManifest,
  spec: GitTriggerSpec,
): ParsedManifest {
  const current = Array.isArray(manifest.raw.triggers)
    ? (manifest.raw.triggers as Record<string, unknown>[])
    : [];
  const idx = current.findIndex(
    (entry) => typeof entry?.slug === 'string' && entry.slug === spec.slug,
  );
  const entry = triggerSpecToTomlEntry(spec);
  const next = current.slice();
  if (idx >= 0) next[idx] = entry;
  else next.push(entry);
  return { ...manifest, raw: { ...manifest.raw, triggers: next } };
}

/** Remove a trigger by slug from the manifest's triggers array. */

export function removeTriggerFromManifest(manifest: ParsedManifest, slug: string): ParsedManifest {
  const current = Array.isArray(manifest.raw.triggers)
    ? (manifest.raw.triggers as Record<string, unknown>[])
    : [];
  const next = current.filter((entry) => !(typeof entry?.slug === 'string' && entry.slug === slug));
  return { ...manifest, raw: { ...manifest.raw, triggers: next } };
}

/**
 * Commit a single file to the project's default branch — the generic engine
 * behind `commitManifest` (kortix.yaml/toml) and the agent-config route's
 * `.md` behavior-file writes. One file, one commit per call.
 */
export async function commitRepoFile(
  project: ProjectRow,
  path: string,
  content: string,
  message: string,
): Promise<{ ok: true } | { error: string; status: number }> {
  const branch = project.defaultBranch;

  // GitHub repos: commit through the Contents API (App / PAT auth) — the
  // lightweight single-file path that doesn't need a full clone.
  const repo = parseGitHubRepoUrl(project.repoUrl);
  if (repo) {
    let auth: GitHubAuthContext | undefined;
    try {
      auth = (await resolveProjectGitAuth(project)).auth ?? undefined;
    } catch (err) {
      return {
        error: `GitHub auth unavailable: ${(err as Error).message || String(err)}`,
        status: 502,
      };
    }
    const existingSha = await getFileSha({
      owner: repo.owner,
      repo: repo.repo,
      path,
      branch,
      auth,
    });
    try {
      await commitFile({
        owner: repo.owner,
        repo: repo.repo,
        path,
        content,
        message,
        branch,
        existingSha: existingSha ?? undefined,
        auth,
      });
    } catch (err) {
      return {
        error: `Failed to commit ${path}: ${(err as Error).message || String(err)}`,
        status: 502,
      };
    }
    invalidateProjectMirror(project.projectId);
    return { ok: true };
  }

  // Any other host (GitLab, generic HTTPS remote): commit via the git CLI.
  // The old code bailed here with "Project repo URL is
  // not a GitHub URL", which broke every connector and trigger manifest edit
  // on managed/self-hosted projects. Mirrors createRemoteSessionBranch's
  // GitHub-fast-path / git-CLI-fallback split.
  let gitProject: ProjectRow & { gitAuthToken: string | null };
  try {
    gitProject = await withProjectGitAuth(project);
  } catch (err) {
    return { error: `Git auth unavailable: ${(err as Error).message || String(err)}`, status: 502 };
  }
  if (!gitProject.gitAuthToken) {
    return { error: 'No git credentials available to write to the project repo', status: 502 };
  }

  try {
    await commitFileToBranch(gitProject, {
      path,
      content,
      message,
      branch,
      authorName: 'Kortix',
      authorEmail: 'noreply@kortix.ai',
    });
  } catch (err) {
    return {
      error: `Failed to commit ${path}: ${(err as Error).message || String(err)}`,
      status: 502,
    };
  }

  invalidateProjectMirror(project.projectId);
  return { ok: true };
}

/**
 * Commit a new revision of the project manifest (kortix.yaml, or kortix.toml
 * for a legacy v1 project) to the project's default branch. All trigger CRUD
 * funnels through this — one file, one commit per edit.
 */

export async function commitManifest(
  project: ProjectRow,
  manifest: ParsedManifest,
  message: string,
): Promise<{ ok: true } | { error: string; status: number }> {
  const content = serializeManifest(manifest);
  // Write back to the SAME file we read (kortix.yaml or kortix.toml, or a custom
  // path) in its own format — never a hardcoded name, or a yaml project's edits
  // would silently land in a second kortix.toml the runtime doesn't read.
  const manifestFile = manifest.path || project.manifestPath || MANIFEST_FILENAME;
  return commitRepoFile(project, manifestFile, content, message);
}

// POST /v1/projects/:projectId/triggers
//
// Creates a new trigger file in the project repo at
// `.opencode/triggers/<slug>.md`. The slug is derived from the body's `slug`
// (or `name`) and validated for URL safety. Body shape:
//   { slug?, name, type: 'cron'|'webhook', agent?, enabled?,
//     prompt_template, cron?, timezone?, secret_env? }

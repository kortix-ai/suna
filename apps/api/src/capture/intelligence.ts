/**
 * Capture Intelligence reads and writes behind intelligence-routes.ts:
 * the overview, workflows (L3), episodes (L1) with their steps (L2), skill
 * drafts and publishing (L4), and bulk exports. Every query is bound to one
 * account (Capture's tenant); the route decides who may ask.
 */
import {
  captureDevices,
  captureEpisodeSteps,
  captureEpisodes,
  captureExports,
  captureWorkflows,
} from '@kortix/db';
import { and, asc, count, desc, eq, gte, ilike, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { countAccountMembers } from '../iam/membership-read';
import type * as C from '@kortix/api-contract';
import { db } from '../shared/db';
import { qualifiedColumn } from '../shared/sql-qualified-column';

export type WorkflowRow = typeof captureWorkflows.$inferSelect;
export type EpisodeRow = typeof captureEpisodes.$inferSelect;
export type WorkflowStatus = 'detected' | 'reviewed' | 'exported';

const num = (v: string | number | null | undefined) => (v === null || v === undefined ? null : Number(v));
const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;

// ─── Workflows (L3) ──────────────────────────────────────────────────────────

export function workflowSummary(w: WorkflowRow): C.CaptureWorkflowSummary {
  return {
    workflow_id: w.workflowId,
    name: w.name,
    goal: w.goal,
    status: w.status as WorkflowStatus,
    runs_total: w.runsTotal,
    runs_per_week: Number(w.runsPerWeek),
    duration_p50_s: w.durationP50S,
    duration_p90_s: w.durationP90S,
    people_count: w.peopleCount,
    apps: w.apps,
    steps_count: w.steps.length,
    variants_count: w.variants.length,
    success_rate: num(w.successRate),
    determinism: Number(w.determinism),
    automation_hours_per_week: Number(w.automationHoursPerWeek),
    first_seen_at: iso(w.firstSeenAt),
    last_seen_at: iso(w.lastSeenAt),
    updated_at: w.updatedAt.toISOString(),
  };
}

export interface WorkflowQuery {
  status?: WorkflowStatus;
  q?: string;
  app?: string;
  userId?: string;
  sort?: 'hours' | 'runs' | 'newest';
  limit: number;
  offset: number;
}

export async function listWorkflows(accountId: string, query: WorkflowQuery) {
  const filters: SQL[] = [eq(captureWorkflows.accountId, accountId)];
  if (query.q) {
    const like = `%${query.q.replace(/[%_]/g, '\\$&')}%`;
    filters.push(or(ilike(captureWorkflows.name, like), ilike(captureWorkflows.goal, like), sql`${captureWorkflows.steps}::text ILIKE ${like}`)!);
  }
  if (query.app) filters.push(sql`${captureWorkflows.apps} ? ${query.app}`);
  if (query.userId) {
    filters.push(sql`EXISTS (SELECT 1 FROM kortix.capture_episodes e WHERE e.workflow_id = ${qualifiedColumn(captureWorkflows.workflowId)} AND e.user_id = ${query.userId}::uuid)`);
  }
  const counts = Object.fromEntries(
    (
      await db
        .select({ status: captureWorkflows.status, n: count() })
        .from(captureWorkflows)
        .where(and(...filters))
        .groupBy(captureWorkflows.status)
    ).map((r) => [r.status, r.n]),
  );
  if (query.status) filters.push(eq(captureWorkflows.status, query.status));
  const order =
    query.sort === 'runs'
      ? [desc(captureWorkflows.runsPerWeek)]
      : query.sort === 'newest'
        ? [desc(captureWorkflows.firstSeenAt)]
        : [desc(captureWorkflows.automationHoursPerWeek)];
  const rows = await db
    .select()
    .from(captureWorkflows)
    .where(and(...filters))
    .orderBy(...order, asc(captureWorkflows.workflowId))
    .limit(query.limit)
    .offset(query.offset);
  const total = (counts.detected ?? 0) + (counts.reviewed ?? 0) + (counts.exported ?? 0);
  return {
    workflows: rows.map(workflowSummary),
    counts: { all: total, detected: counts.detected ?? 0, reviewed: counts.reviewed ?? 0, exported: counts.exported ?? 0 },
  };
}

export async function workflowInAccount(accountId: string, workflowId: string): Promise<WorkflowRow | null> {
  const [row] = await db
    .select()
    .from(captureWorkflows)
    .where(and(eq(captureWorkflows.workflowId, workflowId), eq(captureWorkflows.accountId, accountId)))
    .limit(1);
  return row ?? null;
}

/** The detail: canonical steps, variants, who runs it (runs and p50 per person), review and skill state. */
export async function workflowDetail(w: WorkflowRow): Promise<C.CaptureWorkflowDetail> {
  const people = Array.from(
    await db.execute<{ user_id: string; runs: number; duration_p50_s: number }>(sql`
      SELECT user_id, count(*)::int AS runs,
             round(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM end_at - start_at)))::int AS duration_p50_s
        FROM kortix.capture_episodes WHERE workflow_id = ${w.workflowId}::uuid
       GROUP BY user_id ORDER BY runs DESC LIMIT 50`),
  );
  return {
    ...workflowSummary(w),
    outcome: w.outcome,
    // jsonb columns the miner writes in exactly these shapes (capture/mining.ts).
    steps: w.steps as unknown as C.CaptureWorkflowStep[],
    variants: w.variants as unknown as C.CaptureWorkflowVariant[],
    people,
    reviewed_by: w.reviewedBy,
    reviewed_at: iso(w.reviewedAt),
    skill: (w.skill as C.CaptureWorkflowDetail['skill'] | undefined) ?? null,
    model: w.model,
    cost_usd: Number(w.costUsd),
  };
}

/** A person's review: rename, restate the goal, edit the steps; the workflow reads as reviewed. */
export async function reviewWorkflow(
  w: WorkflowRow,
  patch: { name?: string; goal?: string; outcome?: string; steps?: Record<string, unknown>[] },
  by: string,
): Promise<WorkflowRow> {
  const [row] = await db
    .update(captureWorkflows)
    .set({
      ...(patch.name ? { name: patch.name } : {}),
      ...(patch.goal !== undefined ? { goal: patch.goal } : {}),
      ...(patch.outcome !== undefined ? { outcome: patch.outcome } : {}),
      ...(patch.steps ? { steps: patch.steps } : {}),
      // Review never demotes an exported workflow.
      status: w.status === 'exported' ? 'exported' : 'reviewed',
      reviewedBy: by,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(captureWorkflows.workflowId, w.workflowId))
    .returning();
  return row!;
}

// ─── Episodes (L1) and steps (L2) ────────────────────────────────────────────

export function episodeView(e: EpisodeRow): C.CaptureEpisode {
  return {
    episode_id: e.episodeId,
    user_id: e.userId,
    device_id: e.deviceId,
    source: e.source as 'detected' | 'saved',
    start_at: e.startAt.toISOString(),
    end_at: e.endAt.toISOString(),
    duration_s: Math.round((e.endAt.getTime() - e.startAt.getTime()) / 1000),
    label: e.label,
    goal: e.goal,
    outcome: e.outcome,
    outcome_status: e.outcomeStatus as 'succeeded' | 'failed' | 'abandoned' | null,
    apps: e.apps,
    status: e.status as 'open' | 'closed' | 'traced' | 'failed',
    steps_count: e.stepsCount,
    workflow_id: e.workflowId,
    variant_key: e.variantKey,
    model: e.model,
    cost_usd: Number(e.costUsd),
  };
}

export interface EpisodeQuery {
  /** null = every member (admins and viewers). */
  userId: string | null;
  deviceId?: string;
  workflowId?: string;
  from?: Date;
  to?: Date;
  limit: number;
  /** Keyset cursor: episodes that start before this instant. */
  before?: Date;
}

export async function listEpisodes(accountId: string, query: EpisodeQuery) {
  const filters: SQL[] = [eq(captureEpisodes.accountId, accountId)];
  if (query.userId) filters.push(eq(captureEpisodes.userId, query.userId));
  if (query.deviceId) filters.push(eq(captureEpisodes.deviceId, query.deviceId));
  if (query.workflowId) filters.push(eq(captureEpisodes.workflowId, query.workflowId));
  if (query.from) filters.push(gte(captureEpisodes.endAt, query.from));
  if (query.to) filters.push(lt(captureEpisodes.startAt, query.to));
  if (query.before) filters.push(lt(captureEpisodes.startAt, query.before));
  const rows = await db
    .select()
    .from(captureEpisodes)
    .where(and(...filters))
    .orderBy(desc(captureEpisodes.startAt))
    .limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  return {
    episodes: page.map(episodeView),
    next_before: rows.length > query.limit ? page[page.length - 1]!.startAt.toISOString() : null,
  };
}

export async function episodeInAccount(accountId: string, episodeId: string): Promise<EpisodeRow | null> {
  const [row] = await db
    .select()
    .from(captureEpisodes)
    .where(and(eq(captureEpisodes.episodeId, episodeId), eq(captureEpisodes.accountId, accountId)))
    .limit(1);
  return row ?? null;
}

export async function episodeSteps(episodeId: string): Promise<C.CaptureEpisodeStep[]> {
  const rows = await db
    .select()
    .from(captureEpisodeSteps)
    .where(eq(captureEpisodeSteps.episodeId, episodeId))
    .orderBy(asc(captureEpisodeSteps.index));
  return rows.map((s) => ({
    index: s.index,
    ts: s.ts.toISOString(),
    verb: s.verb,
    app: s.app,
    object: s.object,
    params: s.params,
    variables: s.variables,
    keyframe_frame_id: s.keyframeFrameId,
    action_id: s.actionId,
  }));
}

// ─── Overview ────────────────────────────────────────────────────────────────

export async function overview(accountId: string, span: { from: Date; to: Date }) {
  const prev = { from: new Date(span.from.getTime() - (span.to.getTime() - span.from.getTime())), to: span.from };
  const recorded = async (s: { from: Date; to: Date }) =>
    Number(
      Array.from(
        await db.execute<{ s: number }>(sql`
          SELECT coalesce(sum(extract(epoch FROM least(end_at, ${s.to.toISOString()}::timestamptz) - greatest(start_at, ${s.from.toISOString()}::timestamptz))), 0) AS s
            FROM kortix.timeline_chunks
           WHERE account_id = ${accountId}::uuid AND kind = 'chunk'
             AND end_at > ${s.from.toISOString()}::timestamptz AND start_at < ${s.to.toISOString()}::timestamptz`),
      )[0]!.s,
    );
  const [members] = await countAccountMembers(accountId);
  const [recording] = Array.from(
    await db.execute<{ n: number }>(sql`
      SELECT count(DISTINCT user_id)::int AS n FROM kortix.timeline_chunks
       WHERE account_id = ${accountId}::uuid AND end_at > ${span.from.toISOString()}::timestamptz AND start_at < ${span.to.toISOString()}::timestamptz`),
  );
  const devices = await db
    .select({ statusReportedAt: captureDevices.statusReportedAt, status: captureDevices.status })
    .from(captureDevices)
    .where(and(eq(captureDevices.accountId, accountId), isNull(captureDevices.revokedAt)));
  const now = Date.now();
  const online = devices.filter((d) => d.statusReportedAt && now - d.statusReportedAt.getTime() <= 120_000);
  const workflows = await db.select().from(captureWorkflows).where(eq(captureWorkflows.accountId, accountId));
  const byHours = [...workflows].sort((a, b) => Number(b.automationHoursPerWeek) - Number(a.automationHoursPerWeek));
  const weekAgo = new Date(now - 7 * 86_400_000);
  // Automatable hours a week as of the end of each of the last 12 weeks: the workflows first seen by then.
  const weekMs = 7 * 86_400_000;
  const thisWeek = Math.floor(now / weekMs) * weekMs;
  const trend = Array.from({ length: 12 }, (_, i) => {
    const end = new Date(thisWeek - (10 - i) * weekMs);
    const hours = workflows
      .filter((w) => w.firstSeenAt && w.firstSeenAt < end)
      .reduce((sum, w) => sum + Number(w.automationHoursPerWeek), 0);
    return { week_start: new Date(end.getTime() - weekMs).toISOString(), automation_hours_per_week: Math.round(hours * 10) / 10 };
  });
  const status = (s: WorkflowStatus) => workflows.filter((w) => w.status === s).length;
  return {
    from: span.from.toISOString(),
    to: span.to.toISOString(),
    people: { total: members?.n ?? 0, recording: recording?.n ?? 0 },
    devices: {
      total: devices.length,
      online: online.length,
      needs_permission: devices.filter((d) => d.status && (d.status as Record<string, unknown>).recording === 'permission_missing').length,
    },
    hours_recorded: Math.round((await recorded(span)) / 36) / 100,
    hours_recorded_previous: Math.round((await recorded(prev)) / 36) / 100,
    workflows: { total: workflows.length, detected: status('detected'), reviewed: status('reviewed'), exported: status('exported') },
    automation_hours_per_week: Math.round(workflows.reduce((s, w) => s + Number(w.automationHoursPerWeek), 0) * 10) / 10,
    top_opportunities: byHours.slice(0, 5).map(workflowSummary),
    new_this_week: workflows
      .filter((w) => w.firstSeenAt && w.firstSeenAt >= weekAgo)
      .sort((a, b) => b.firstSeenAt!.getTime() - a.firstSeenAt!.getTime())
      .map(workflowSummary),
    trend,
  };
}

// ─── Exports ─────────────────────────────────────────────────────────────────

export type ExportRow = typeof captureExports.$inferSelect;

export function exportView(e: ExportRow, url: { url: string; expires_at: string } | null = null): C.CaptureExport {
  return {
    export_id: e.exportId,
    format: e.format as 'jsonl' | 'parquet',
    params: e.params,
    status: e.status as 'queued' | 'running' | 'done' | 'failed',
    rows: e.rows,
    bytes: e.bytes,
    error: e.error,
    download: url,
    created_at: e.createdAt.toISOString(),
    updated_at: e.updatedAt.toISOString(),
  };
}

export async function createExport(input: {
  accountId: string;
  requestedBy: string;
  format: 'jsonl' | 'parquet';
  params: Record<string, unknown>;
}): Promise<ExportRow> {
  const [row] = await db.insert(captureExports).values(input).returning();
  return row!;
}

export async function exportInAccount(accountId: string, exportId: string): Promise<ExportRow | null> {
  const [row] = await db
    .select()
    .from(captureExports)
    .where(and(eq(captureExports.exportId, exportId), eq(captureExports.accountId, accountId)))
    .limit(1);
  return row ?? null;
}

export async function listExports(accountId: string) {
  const rows = await db
    .select()
    .from(captureExports)
    .where(eq(captureExports.accountId, accountId))
    .orderBy(desc(captureExports.createdAt))
    .limit(50);
  return rows;
}


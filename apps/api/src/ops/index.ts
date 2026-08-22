import { createRoute, z } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import type { AppEnv } from '../types';
import { db } from '../shared/db';
import { supabaseAuth } from '../middleware/auth';
import { requireAdmin } from '../middleware/require-admin';
import { config } from '../config';
import { getTunnelServiceStatus } from '../tunnel';
import { isOtelTraceExporterConfigured } from '../lib/otel';
import { makeOpenApiApp, json, errors, auth } from '../openapi';

export const opsApp = makeOpenApiApp<AppEnv>();

opsApp.use('/*', supabaseAuth);
opsApp.use('/*', requireAdmin);

type CountRow = { count: number | string | null };
type GroupCountRow = { key: string | null; count: number | string | null };

type RecentAuditEvent = {
  event_id: string;
  account_id: string | null;
  actor_user_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  occurred_at: string;
};

type UsageRow = {
  provider: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cost_usd: number;
};

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown[] } | null)?.rows;
  return Array.isArray(rows) ? rows as T[] : [];
}

async function oneCount(query: ReturnType<typeof sql>): Promise<number> {
  const rows = resultRows<CountRow>(await db.execute(query));
  return Number(rows[0]?.count ?? 0);
}

async function groupCounts(query: ReturnType<typeof sql>): Promise<Record<string, number>> {
  const rows = resultRows<GroupCountRow>(await db.execute(query));
  return Object.fromEntries(rows.map((row) => [row.key ?? 'unknown', Number(row.count ?? 0)]));
}

/**
 * Controlled degradation for the ops overview dashboard.
 *
 * `/ops/overview` fans out ~10 independent count/group queries in a single
 * `Promise.all`. Originally any one of them rejecting (a statement_timeout on
 * an unindexed scan, a transient connection drop, a slow replica) rejected the
 * WHOLE promise and 500'd the entire dashboard — even though the other 9
 * metrics were perfectly healthy. That single-query failure mode was the path
 * the audit_events 24h count reached Sentry/Better Stack as an unhandled error
 * (4ba74f8c17f3e48e13c07511fb802ec55ba07294237c0985f3df792729e8f4d8): the
 * account-agnostic `count(*) ... WHERE occurred_at >= now() - interval '24h'`
 * had no usable index (all three audit_events indices have a different leading
 * column) and, on a large audit_events table, exceeded the 25s
 * statement_timeout.
 *
 * The structural fix is the new `idx_audit_events_occurred_at` index. These
 * `safe*` wrappers are the resilience layer: a single failing metric degrades
 * to a `null` sentinel and the dashboard still returns 200 with the rest,
 * while the underlying error is still logged loudly here so a real DB outage
 * is observable — it just no longer pages as an unhandled error.
 *
 * Scope is deliberately narrow: ONLY the ops-overview aggregation queries
 * (each a self-contained read with no side effects) are wrapped. User-facing
 * request paths keep throwing — this is not a blanket DB error suppressor.
 */
async function safeCount(label: string, query: ReturnType<typeof sql>): Promise<number | null> {
  try {
    return await oneCount(query);
  } catch (err) {
    console.error(`[ops/overview] ${label} query failed — degrading to null:`, err);
    return null;
  }
}

async function safeGroup(
  label: string,
  query: ReturnType<typeof sql>,
): Promise<Record<string, number>> {
  try {
    return await groupCounts(query);
  } catch (err) {
    console.error(`[ops/overview] ${label} query failed — degrading to {} :`, err);
    return {};
  }
}

async function safeRecentAuditEvents(): Promise<RecentAuditEvent[] | null> {
  try {
    return await recentAuditEvents();
  } catch (err) {
    console.error('[ops/overview] recent audit events query failed — degrading to null:', err);
    return null;
  }
}

async function safeUsageLast24h(): Promise<UsageRow[] | null> {
  try {
    return await usageLast24h();
  } catch (err) {
    console.error('[ops/overview] usage 24h query failed — degrading to null:', err);
    return null;
  }
}

async function recentAuditEvents(): Promise<RecentAuditEvent[]> {
  const rows = resultRows<{
    event_id: string;
    account_id: string | null;
    actor_user_id: string | null;
    action: string;
    resource_type: string;
    resource_id: string | null;
    occurred_at: Date | string;
  }>(await db.execute(sql`
    SELECT event_id, account_id, actor_user_id, action, resource_type, resource_id, occurred_at
    FROM kortix.audit_events
    ORDER BY occurred_at DESC
    LIMIT 10
  `));

  return rows.map((row) => ({
    event_id: row.event_id,
    account_id: row.account_id,
    actor_user_id: row.actor_user_id,
    action: row.action,
    resource_type: row.resource_type,
    resource_id: row.resource_id,
    occurred_at: new Date(row.occurred_at).toISOString(),
  }));
}

async function usageLast24h(): Promise<UsageRow[]> {
  const rows = resultRows<{
    provider: string;
    calls: number | string;
    input_tokens: number | string | null;
    output_tokens: number | string | null;
    cached_tokens: number | string | null;
    cost_usd: string | number | null;
  }>(await db.execute(sql`
    SELECT
      provider,
      count(*)::int AS calls,
      COALESCE(sum(input_tokens), 0)::int AS input_tokens,
      COALESCE(sum(output_tokens), 0)::int AS output_tokens,
      COALESCE(sum(cached_tokens), 0)::int AS cached_tokens,
      COALESCE(sum(cost_usd), 0)::text AS cost_usd
    FROM kortix.usage_events
    WHERE created_at >= now() - interval '24 hours'
    GROUP BY provider
    ORDER BY calls DESC
  `));

  return rows.map((row) => ({
    provider: row.provider,
    calls: Number(row.calls ?? 0),
    input_tokens: Number(row.input_tokens ?? 0),
    output_tokens: Number(row.output_tokens ?? 0),
    cached_tokens: Number(row.cached_tokens ?? 0),
    cost_usd: Number(row.cost_usd ?? 0),
  }));
}

function observabilityStatus() {
  return {
    managed_logs_configured: Boolean(process.env.BETTERSTACK_API_LOG_TOKEN),
    managed_log_host: process.env.BETTERSTACK_API_LOG_TOKEN
      ? process.env.BETTERSTACK_API_LOG_HOST || 'default'
      : null,
    error_tracking_configured: Boolean(process.env.BETTERSTACK_API_SENTRY_DSN),
    structured_request_logs_enabled: true,
    trace_headers_enabled: true,
    otlp_exporter_configured: isOtelTraceExporterConfigured(),
    otlp_request_spans_enabled: isOtelTraceExporterConfigured(),
  };
}

opsApp.openapi(
  createRoute({
    method: 'get',
    path: '/overview',
    tags: ['ops'],
    summary: 'Platform operations overview dashboard',
    ...auth,
    responses: {
      200: json(z.record(z.string(), z.any()), 'Operations overview snapshot'),
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
  const [
    accountCount,
    projectCount,
    activeLegacySandboxes,
    sessionStatus,
    sandboxStatus,
    sandboxProviders,
    triggerEventStatus,
    audit24h,
    migrationStatus,
    usage,
    recentAudit,
  ] = await Promise.all([
    // Each aggregation runs through a safe* wrapper so a single failing query
    // degrades to a null/{} sentinel instead of rejecting the whole
    // Promise.all and 500-ing the dashboard. See safeCount's doc comment.
    safeCount('accounts', sql`SELECT count(*)::int AS count FROM kortix.accounts`),
    safeCount('projects', sql`SELECT count(*)::int AS count FROM kortix.projects`),
    safeCount(
      'active_legacy_sandboxes',
      sql`
        SELECT count(*)::int AS count
        FROM kortix.sandboxes
        WHERE status IN ('provisioning', 'active', 'stopped', 'error')
      `,
    ),
    safeGroup('sessions_by_status', sql`
      SELECT status AS key, count(*)::int AS count
      FROM kortix.project_sessions
      GROUP BY status
    `),
    safeGroup('sandboxes_by_status', sql`
      SELECT status AS key, count(*)::int AS count
      FROM kortix.session_sandboxes
      GROUP BY status
    `),
    safeGroup('sandboxes_by_provider', sql`
      SELECT provider AS key, count(*)::int AS count
      FROM kortix.session_sandboxes
      GROUP BY provider
    `),
    // Triggers are file-defined (kortix.yaml) now; the project_trigger_events
    // table is gone and the git path doesn't persist events, so this is always
    // empty. Field kept for dashboard compatibility.
    Promise.resolve<Record<string, number>>({}),
    safeCount(
      'audit_events_24h',
      sql`
        SELECT count(*)::int AS count
        FROM kortix.audit_events
        WHERE occurred_at >= now() - interval '24 hours'
      `,
    ),
    safeGroup('legacy_sandbox_migrations_by_status', sql`
      SELECT status AS key, count(*)::int AS count
      FROM kortix.legacy_sandbox_migrations
      GROUP BY status
    `),
    safeUsageLast24h(),
    safeRecentAuditEvents(),
  ]);

  const queuedTriggerEvents = triggerEventStatus.queued ?? 0;
  const erroredSessions = sessionStatus.failed ?? 0;
  const erroredSandboxes = sandboxStatus.error ?? 0;

  return c.json({
    generated_at: new Date().toISOString(),
    api: {
      status: 'ok',
      env: config.INTERNAL_KORTIX_ENV,
      billing_enabled: config.KORTIX_BILLING_INTERNAL_ENABLED,
      tunnel: getTunnelServiceStatus(),
    },
    totals: {
      accounts: accountCount,
      projects: projectCount,
      active_legacy_sandboxes: activeLegacySandboxes,
    },
    sessions: {
      by_status: sessionStatus,
      errored: erroredSessions,
    },
    sandboxes: {
      by_status: sandboxStatus,
      by_provider: sandboxProviders,
      errored: erroredSandboxes,
    },
    queues: {
      trigger_events_by_status: triggerEventStatus,
      // Channel events are file-defined now (no queue table); kept for dashboard
      // shape compatibility so the UI never reads an undefined map.
      channel_events_by_status: {},
      queued_total: queuedTriggerEvents,
    },
    audit: {
      // null when the audit_events 24h count failed (e.g. pre-index timeout).
      // The dashboard renders "—" instead of the request 500-ing.
      events_24h: audit24h,
      recent: recentAudit,
    },
    usage: {
      last_24h_by_provider: usage,
      // null when the usage 24h query failed — guard the aggregation.
      calls_24h: usage ? usage.reduce((sum, row) => sum + row.calls, 0) : null,
      cost_usd_24h: usage ? usage.reduce((sum, row) => sum + row.cost_usd, 0) : null,
    },
    observability: observabilityStatus(),
    migrations: {
      by_status: migrationStatus,
      active_legacy_sandboxes: activeLegacySandboxes,
    },
  });
  },
);

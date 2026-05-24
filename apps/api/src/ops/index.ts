import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import type { AppEnv } from '../types';
import { db } from '../shared/db';
import { supabaseAuth } from '../middleware/auth';
import { requireAdmin } from '../middleware/require-admin';
import { config } from '../config';
import { getTunnelServiceStatus } from '../tunnel';
import { isOtelTraceExporterConfigured } from '../lib/otel';

export const opsApp = new Hono<AppEnv>();

opsApp.use('/*', supabaseAuth);
opsApp.use('/*', requireAdmin);

type CountRow = { count: number | string | null };
type GroupCountRow = { key: string | null; count: number | string | null };

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

async function recentAuditEvents() {
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

async function usageLast24h() {
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

opsApp.get('/overview', async (c) => {
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
    oneCount(sql`SELECT count(*)::int AS count FROM kortix.accounts`),
    oneCount(sql`SELECT count(*)::int AS count FROM kortix.projects`),
    oneCount(sql`
      SELECT count(*)::int AS count
      FROM kortix.sandboxes
      WHERE status IN ('provisioning', 'active', 'stopped', 'error')
    `),
    groupCounts(sql`
      SELECT status AS key, count(*)::int AS count
      FROM kortix.project_sessions
      GROUP BY status
    `),
    groupCounts(sql`
      SELECT status AS key, count(*)::int AS count
      FROM kortix.session_sandboxes
      GROUP BY status
    `),
    groupCounts(sql`
      SELECT provider AS key, count(*)::int AS count
      FROM kortix.session_sandboxes
      GROUP BY provider
    `),
    // Triggers are file-defined (kortix.toml) now; the project_trigger_events
    // table is gone and the git path doesn't persist events, so this is always
    // empty. Field kept for dashboard compatibility.
    Promise.resolve<Record<string, number>>({}),
    oneCount(sql`
      SELECT count(*)::int AS count
      FROM kortix.audit_events
      WHERE occurred_at >= now() - interval '24 hours'
    `),
    groupCounts(sql`
      SELECT status AS key, count(*)::int AS count
      FROM kortix.legacy_sandbox_migrations
      GROUP BY status
    `),
    usageLast24h(),
    recentAuditEvents(),
  ]);

  const queuedTriggerEvents = triggerEventStatus.queued ?? 0;
  const erroredSessions = sessionStatus.failed ?? 0;
  const erroredSandboxes = sandboxStatus.error ?? 0;

  return c.json({
    generated_at: new Date().toISOString(),
    api: {
      status: 'ok',
      env: config.ENV_MODE,
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
      queued_total: queuedTriggerEvents,
    },
    audit: {
      events_24h: audit24h,
      recent: recentAudit,
    },
    usage: {
      last_24h_by_provider: usage,
      calls_24h: usage.reduce((sum, row) => sum + row.calls, 0),
      cost_usd_24h: usage.reduce((sum, row) => sum + row.cost_usd, 0),
    },
    observability: observabilityStatus(),
    migrations: {
      by_status: migrationStatus,
      active_legacy_sandboxes: activeLegacySandboxes,
    },
  });
});

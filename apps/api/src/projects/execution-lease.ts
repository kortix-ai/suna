import { sessionSandboxes } from '@kortix/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { type ProviderName, getProvider } from '../platform/providers';
import { db } from '../shared/db';

export const DEFAULT_EXECUTION_LEASE_SECONDS = 120;
export const MIN_EXECUTION_LEASE_SECONDS = 30;
export const MAX_EXECUTION_LEASE_SECONDS = 300;
const PROVIDER_TOUCH_TIMEOUT_MS = 5_000;

export interface ExecutionLeaseTarget {
  sandboxId: string;
  sessionId: string;
  projectId: string;
}

export interface ExecutionKeepAliveEndpoint {
  url: string;
  headers: Record<string, string>;
}

function keepAliveEndpoint(url: string, headers: Record<string, string>): ExecutionKeepAliveEndpoint {
  const safeHeaders = Object.fromEntries(
    Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'authorization'),
  );
  return { url: url.replace(/\/$/, ''), headers: safeHeaders };
}

function clampLeaseSeconds(requested?: number): number {
  if (!Number.isFinite(requested)) return DEFAULT_EXECUTION_LEASE_SECONDS;
  return Math.max(
    MIN_EXECUTION_LEASE_SECONDS,
    Math.min(MAX_EXECUTION_LEASE_SECONDS, Math.floor(requested as number)),
  );
}

export function executionLeaseUntilOf(metadata: Record<string, unknown> | null): Date | null {
  const raw = metadata?.executionLeaseUntil;
  if (typeof raw !== 'string') return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function hasActiveExecutionLease(
  metadata: Record<string, unknown> | null,
  now = new Date(),
): boolean {
  const until = executionLeaseUntilOf(metadata);
  return until !== null && until.getTime() > now.getTime();
}

async function loadLeaseSandbox(target: ExecutionLeaseTarget) {
  const [row] = await db
    .select({ provider: sessionSandboxes.provider, externalId: sessionSandboxes.externalId })
    .from(sessionSandboxes)
    .where(
      and(
        eq(sessionSandboxes.sandboxId, target.sandboxId),
        eq(sessionSandboxes.sessionId, target.sessionId),
        eq(sessionSandboxes.projectId, target.projectId),
        inArray(sessionSandboxes.status, ['provisioning', 'active']),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function discoverExecutionKeepAliveEndpoint(
  target: ExecutionLeaseTarget,
): Promise<ExecutionKeepAliveEndpoint | null> {
  const row = await loadLeaseSandbox(target);
  if (!row?.externalId) return null;
  const endpoint = await getProvider(row.provider as ProviderName).resolveEndpoint(row.externalId);
  return keepAliveEndpoint(endpoint.url, endpoint.headers);
}

async function touchProvider(
  provider: ProviderName,
  externalId: string,
): Promise<ExecutionKeepAliveEndpoint | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const endpoint = await getProvider(provider).resolveEndpoint(externalId);
      const keepAlive = keepAliveEndpoint(endpoint.url, endpoint.headers);
      const response = await fetch(`${keepAlive.url}/kortix/health`, {
        headers: endpoint.headers,
        signal: AbortSignal.timeout(PROVIDER_TOUCH_TIMEOUT_MS),
      });
      if (response.ok || response.status === 503) return keepAlive;
    } catch {
      /* the next heartbeat retries; the DB lease remains authoritative */
    }
  }
  return null;
}

export async function renewExecutionLease(
  target: ExecutionLeaseTarget,
  requestedTtlSeconds?: number,
  now = new Date(),
): Promise<{
  ok: boolean;
  leaseUntil: string | null;
  providerUrl: string | null;
  providerHeaders: Record<string, string> | null;
}> {
  const leaseUntil = new Date(
    now.getTime() + clampLeaseSeconds(requestedTtlSeconds) * 1_000,
  ).toISOString();
  const patch = JSON.stringify({
    executionLeaseUntil: leaseUntil,
    lastTurnAt: now.toISOString(),
    idleObservedAt: null,
  });
  const [row] = await db
    .update(sessionSandboxes)
    .set({
      metadata: sql`coalesce(${sessionSandboxes.metadata}, '{}'::jsonb) || ${patch}::jsonb`,
      lastUsedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(sessionSandboxes.sandboxId, target.sandboxId),
        eq(sessionSandboxes.sessionId, target.sessionId),
        eq(sessionSandboxes.projectId, target.projectId),
        inArray(sessionSandboxes.status, ['provisioning', 'active']),
      ),
    )
    .returning({ provider: sessionSandboxes.provider, externalId: sessionSandboxes.externalId });
  if (!row) {
    return { ok: false, leaseUntil: null, providerUrl: null, providerHeaders: null };
  }
  const providerEndpoint = row.externalId
    ? await touchProvider(row.provider as ProviderName, row.externalId)
    : null;
  return {
    ok: true,
    leaseUntil,
    providerUrl: providerEndpoint?.url ?? null,
    providerHeaders: providerEndpoint?.headers ?? null,
  };
}

export async function releaseExecutionLease(
  target: ExecutionLeaseTarget,
  now = new Date(),
): Promise<boolean> {
  const patch = JSON.stringify({ executionLeaseUntil: null });
  const rows = await db
    .update(sessionSandboxes)
    .set({
      metadata: sql`coalesce(${sessionSandboxes.metadata}, '{}'::jsonb) || ${patch}::jsonb`,
      updatedAt: now,
    })
    .where(
      and(
        eq(sessionSandboxes.sandboxId, target.sandboxId),
        eq(sessionSandboxes.sessionId, target.sessionId),
        eq(sessionSandboxes.projectId, target.projectId),
      ),
    )
    .returning({ sandboxId: sessionSandboxes.sandboxId });
  return rows.length > 0;
}

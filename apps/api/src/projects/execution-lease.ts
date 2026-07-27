import { sessionSandboxes } from '@kortix/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { setContextField } from '../lib/request-context';
import { type ProviderName, getProvider } from '../platform/providers';
import { db } from '../shared/db';

export const DEFAULT_EXECUTION_LEASE_SECONDS = 120;
export const MIN_EXECUTION_LEASE_SECONDS = 30;
export const MAX_EXECUTION_LEASE_SECONDS = 300;

export interface ExecutionLeaseTarget {
  sandboxId: string;
  sessionId: string;
  projectId: string;
  accountId: string;
}

export interface ExecutionKeepAliveEndpoint {
  url: string;
  headers: Record<string, string>;
}

function keepAliveEndpoint(
  url: string,
  headers: Record<string, string>,
): ExecutionKeepAliveEndpoint {
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
        eq(sessionSandboxes.accountId, target.accountId),
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
  // resolveEndpoint delegates to the provider's ingress resolution (Daytona's
  // getPreviewLink), which can throw a `DaytonaRateLimitError` on an org-wide
  // 429 `ThrottlerException`. This is a BEST-EFFORT discover path (the sandbox
  // agent calls it on turn start to find its keep-alive target); an expected
  // provider 429 must NOT bubble up to `app.onError` → Sentry → Better Stack
  // (the recurring `ec26b248…` fingerprint). Degrade to `null` — the caller
  // treats null as "no keep-alive endpoint yet" and the DB lease remains
  // authoritative.
  try {
    const providerGetStart = Date.now();
    const provider = getProvider(row.provider as ProviderName);
    const providerGetMs = Date.now() - providerGetStart;
    const previewLinkStart = Date.now();
    const endpoint = await provider.resolveEndpoint(row.externalId);
    setContextField('provider_get_ms', String(providerGetMs));
    setContextField('preview_link_ms', String(Date.now() - previewLinkStart));
    return keepAliveEndpoint(endpoint.url, endpoint.headers);
  } catch (err) {
    console.warn(
      `[execution-lease] discover keep-alive endpoint failed for sandbox ${row.externalId}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

async function resolveKeepAliveEndpoint(
  provider: ProviderName,
  externalId: string,
): Promise<ExecutionKeepAliveEndpoint | null> {
  // Instrumented: preview_link_ms isolates the provider resolveEndpoint cost,
  // which prior analysis could only infer. Purely additive observability.
  try {
    const providerGetStart = Date.now();
    const providerInstance = getProvider(provider);
    const providerGetMs = Date.now() - providerGetStart;
    const previewLinkStart = Date.now();
    const endpoint = await providerInstance.resolveEndpoint(externalId);
    setContextField('provider_get_ms', String(providerGetMs));
    setContextField('preview_link_ms', String(Date.now() - previewLinkStart));
    return keepAliveEndpoint(endpoint.url, endpoint.headers);
  } catch (err) {
    console.warn(
      `[execution-lease] resolve keep-alive endpoint failed for sandbox ${externalId}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

async function writeExecutionLease(
  target: ExecutionLeaseTarget,
  requestedTtlSeconds?: number,
  now = new Date(),
): Promise<{
  leaseUntil: string;
  provider: string;
  externalId: string | null;
} | null> {
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
        eq(sessionSandboxes.accountId, target.accountId),
        inArray(sessionSandboxes.status, ['provisioning', 'active']),
      ),
    )
    .returning({ provider: sessionSandboxes.provider, externalId: sessionSandboxes.externalId });
  return row ? { ...row, leaseUntil } : null;
}

export async function acquireExecutionLease(
  target: ExecutionLeaseTarget,
  requestedTtlSeconds?: number,
  now = new Date(),
): Promise<{
  ok: boolean;
  leaseUntil: string | null;
  providerUrl: string | null;
  providerHeaders: Record<string, string> | null;
}> {
  const row = await writeExecutionLease(target, requestedTtlSeconds, now);
  if (!row) {
    return { ok: false, leaseUntil: null, providerUrl: null, providerHeaders: null };
  }
  const providerEndpoint = row.externalId
    ? await resolveKeepAliveEndpoint(row.provider as ProviderName, row.externalId)
    : null;
  return {
    ok: true,
    leaseUntil: row.leaseUntil,
    providerUrl: providerEndpoint?.url ?? null,
    providerHeaders: providerEndpoint?.headers ?? null,
  };
}

export async function renewExecutionLease(
  target: ExecutionLeaseTarget,
  requestedTtlSeconds?: number,
  now = new Date(),
): Promise<{
  ok: boolean;
  leaseUntil: string | null;
  providerUrl: null;
  providerHeaders: null;
}> {
  const row = await writeExecutionLease(target, requestedTtlSeconds, now);
  return {
    ok: row !== null,
    leaseUntil: row?.leaseUntil ?? null,
    providerUrl: null,
    providerHeaders: null,
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
        eq(sessionSandboxes.accountId, target.accountId),
      ),
    )
    .returning({ sandboxId: sessionSandboxes.sandboxId });
  return rows.length > 0;
}

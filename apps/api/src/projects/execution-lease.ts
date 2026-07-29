import { sessionSandboxes } from '@kortix/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { setContextField } from '../lib/request-context';
import { type ProviderName, getProvider } from '../platform/providers';
import { db } from '../shared/db';
import { positiveEnvInt } from './reaper-constants';

export const DEFAULT_EXECUTION_LEASE_SECONDS = 120;
export const MIN_EXECUTION_LEASE_SECONDS = 30;
export const MAX_EXECUTION_LEASE_SECONDS = 300;

/**
 * THE LEASE CEILING — the bound on how long a sandbox may keep granting itself
 * a reprieve.
 *
 * The execution lease is written by the IN-SANDBOX reporter
 * (kortix-sandbox-agent-server/src/execution-lease.ts), which renews every ~60s
 * for as long as its local opencode believes ANY session is 'busy' or 'retry'.
 * `hasActiveExecutionLease` short-circuits the reaper BEFORE it probes, so an
 * unbounded renew is an unbounded veto: a retry loop, a dropped opencode event
 * subscription, or any daemon wedge buys the box immortality. Measured live
 * 2026-07-29: 187 leased boxes genuinely running, 175 of them older than 12h,
 * the oldest 264 hours, and 156 of them had never emitted a single LLM call.
 *
 * So the renew is now cumulative-bounded per sandbox row: the FIRST lease write
 * anchors `metadata.executionLeaseStartedAt`, the anchor is never advanced by a
 * later sandbox-authored write, and past the ceiling every further acquire/renew
 * is refused. Refusing does NOT kill the box — it only drops the short-circuit
 * so the reaper evaluates it normally (busy probe → idle arm → stop, plus the
 * absolute ceiling in reaping/policy.ts). A genuinely mid-turn box still wins
 * its veto from the control-plane-initiated busy probe, which is why this cannot
 * recreate the 2026-06-24 "idle sandboxes stopping too quickly mid-session"
 * regression.
 *
 * Only a control-plane-observed event resets the anchor: waking a stopped box
 * (projects/routes/shared.ts) clears it, because a stopped box burns nothing.
 */
const DEFAULT_MAX_LEASE_HELD_MINUTES = 360;

export function maxLeaseHeldMs(): number {
  return (
    positiveEnvInt('KORTIX_EXECUTION_LEASE_MAX_HELD_MINUTES', DEFAULT_MAX_LEASE_HELD_MINUTES) *
    60_000
  );
}

/** Kill switch for the lease ceiling. Default ON — enforcement is the default. */
export function leaseCeilingEnforced(): boolean {
  return process.env.KORTIX_EXECUTION_LEASE_CEILING_ENABLED !== 'false';
}

/**
 * Every metadata key the lease owns. A control-plane-OBSERVED wake of a stopped
 * box (projects/routes/shared.ts) deletes exactly these, which is what restores
 * lease eligibility to a box that had exhausted the ceiling before it was
 * stopped. Nothing the sandbox itself can call may clear them — that is the
 * difference between shortening a life and extending one.
 */
export const EXECUTION_LEASE_METADATA_KEYS = [
  'executionLeaseUntil',
  'executionLeaseStartedAt',
] as const;

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

/** When this sandbox row FIRST took an execution lease. Written once by the
 *  API, never advanced by the sandbox — the anchor the ceiling measures from. */
export function executionLeaseStartedAtOf(metadata: Record<string, unknown> | null): Date | null {
  const raw = metadata?.executionLeaseStartedAt;
  if (typeof raw !== 'string') return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export type ExecutionLeaseWriteDecision =
  | { allowed: false; heldMs: number }
  | { allowed: true; heldMs: number; leaseUntil: string; patch: Record<string, unknown> };

/**
 * The whole lease-write decision, pure so the money semantics are exhaustively
 * unit-tested without a DB.
 *
 * Note what the patch does NOT contain: `lastTurnAt`. Until 2026-07-29 every
 * lease write stamped `lastTurnAt = now`, which is the exact signal
 * `reaping/policy.ts lastMeaningfulAt` uses to judge the box — so the sandbox
 * forged its own alibi and erased the fallback activity clock in the same
 * statement. A sandbox-reported signal may only SHORTEN a sandbox's life; the
 * activity clock is now advanced only by control-plane-observed events (the
 * reaper's own busy probe, an explicit wake, an in-place restart).
 */
export function decideExecutionLeaseWrite(input: {
  metadata: Record<string, unknown> | null;
  requestedTtlSeconds?: number;
  now: Date;
  ceilingMs: number;
  enforced?: boolean;
}): ExecutionLeaseWriteDecision {
  const { metadata, requestedTtlSeconds, now, ceilingMs } = input;
  const stored = executionLeaseStartedAtOf(metadata);
  // A stored anchor in the future can only come from a clock skew or a hand-edit;
  // trusting it would make heldMs negative and restore the immortality this
  // exists to remove, so it is clamped back to now.
  const anchor = stored && stored.getTime() <= now.getTime() ? stored : now;
  const heldMs = now.getTime() - anchor.getTime();
  if (input.enforced !== false && heldMs >= ceilingMs) return { allowed: false, heldMs };
  const leaseUntil = new Date(
    now.getTime() + clampLeaseSeconds(requestedTtlSeconds) * 1_000,
  ).toISOString();
  return {
    allowed: true,
    heldMs,
    leaseUntil,
    patch: {
      executionLeaseUntil: leaseUntil,
      executionLeaseStartedAt: anchor.toISOString(),
      idleObservedAt: null,
    },
  };
}

async function loadLeaseSandbox(target: ExecutionLeaseTarget) {
  const [row] = await db
    .select({
      provider: sessionSandboxes.provider,
      externalId: sessionSandboxes.externalId,
      metadata: sessionSandboxes.metadata,
    })
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
  const current = await loadLeaseSandbox(target);
  if (!current) return null;
  const decision = decideExecutionLeaseWrite({
    metadata: (current.metadata ?? null) as Record<string, unknown> | null,
    requestedTtlSeconds,
    now,
    ceilingMs: maxLeaseHeldMs(),
    enforced: leaseCeilingEnforced(),
  });
  if (!decision.allowed) {
    console.warn('[execution-lease] renew refused — cumulative lease ceiling reached', {
      sandbox_id: target.sandboxId,
      held_ms: decision.heldMs,
      ceiling_ms: maxLeaseHeldMs(),
    });
    return null;
  }
  const { leaseUntil } = decision;
  const patch = JSON.stringify(decision.patch);
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

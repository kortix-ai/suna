/**
 * Plan usage of a subscription login (a ChatGPT or Claude account stored as an
 * account secret resource): how much of its 5-hour and weekly windows is used.
 *
 * Two writers keep `account_secret_resources.usage` current:
 *   1. the gateway, from the headers of every model response on that login
 *      (`/internal/gateway/pool-usage`, throttled per replica);
 *   2. `refreshSubscriptionUsage`, which asks the provider's usage API when
 *      someone opens the account list, at most once a minute per login. It
 *      costs no plan quota: ChatGPT `GET /backend-api/wham/usage`, Claude
 *      `GET /api/oauth/usage`.
 * A refresh the provider refuses keeps the last stored snapshot.
 */
import { accountSecretResources } from '@kortix/db';
import { windowId, type SubscriptionUsage } from '@kortix/llm-gateway';
import { and, eq, sql } from 'drizzle-orm';
import { z } from '@hono/zod-openapi';
import { db } from '../shared/db';
import { logger } from '../lib/logger';
import { readAccountSecret } from '../secrets/account-resource';
import { CODEX_USER_AGENT, resolveCodexAccountCredential } from './credentials/codex';

export const SUBSCRIPTION_PROVIDERS = new Set(['codex', 'claude-agent']);

export const SubscriptionUsageSchema = z.object({
  windows: z.array(z.object({
    id: z.string().min(1).max(40),
    window_minutes: z.number().int().positive().nullable(),
    used_percent: z.number().min(0).max(100),
    resets_at: z.string().datetime().nullable(),
  })).max(8),
  limited: z.boolean(),
  observed_at: z.string().datetime(),
  source: z.enum(['response', 'usage_endpoint']),
});

/** The stored snapshot, or null when none was seen or it no longer parses. */
export function storedSubscriptionUsage(value: unknown): SubscriptionUsage | null {
  const parsed = SubscriptionUsageSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Store a snapshot unless a newer one is already stored: two replicas may
 * report the same login out of order.
 */
export async function recordSubscriptionUsage(secretId: string, accountId: string, usage: SubscriptionUsage): Promise<void> {
  await db.update(accountSecretResources).set({ usage })
    .where(and(
      eq(accountSecretResources.secretId, secretId),
      eq(accountSecretResources.accountId, accountId),
      sql`coalesce((${accountSecretResources.usage}->>'observed_at')::timestamptz, '-infinity') <= ${usage.observed_at}::timestamptz`,
    ));
}

type FetchImpl = (input: string, init: RequestInit) => Promise<Response>;

const REFRESH_EVERY_MS = 60_000;
const PROVIDER_TIMEOUT_MS = 8_000;

interface UsageEndpointWindow { used_percent: number; window_minutes: number | null; resets_at: string | null; fallback: string }

function snapshot(windows: UsageEndpointWindow[], limited: boolean, now: number): SubscriptionUsage | null {
  if (!windows.length) return null;
  const shaped = windows
    .map(({ fallback, ...window }) => ({ id: windowId(window.window_minutes, fallback), ...window, used_percent: Math.round(Math.min(100, Math.max(0, window.used_percent)) * 10) / 10 }))
    .sort((a, b) => (a.window_minutes ?? Infinity) - (b.window_minutes ?? Infinity));
  return {
    windows: shaped,
    limited: limited || shaped.some((window) => window.used_percent >= 100),
    observed_at: new Date(now).toISOString(),
    source: 'usage_endpoint',
  };
}

function isoOrNull(value: unknown, now: number, afterSeconds?: unknown): string | null {
  if (typeof value === 'number' && value > 0) return new Date(value * 1000).toISOString();
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  if (typeof afterSeconds === 'number' && afterSeconds >= 0) return new Date(now + afterSeconds * 1000).toISOString();
  return null;
}

/** ChatGPT's `wham/usage` body: `rate_limit.{primary,secondary}_window`, `used_percent` 0–100. */
export function codexUsageFromBody(body: unknown, now = Date.now()): SubscriptionUsage | null {
  const rateLimit = (body as { rate_limit?: Record<string, unknown> } | null)?.rate_limit;
  if (!rateLimit || typeof rateLimit !== 'object') return null;
  const windows: UsageEndpointWindow[] = [];
  for (const slot of ['primary', 'secondary'] as const) {
    const window = rateLimit[`${slot}_window`] as Record<string, unknown> | null | undefined;
    if (!window || typeof window.used_percent !== 'number') continue;
    const seconds = typeof window.limit_window_seconds === 'number' ? window.limit_window_seconds : null;
    windows.push({
      fallback: slot,
      used_percent: window.used_percent,
      window_minutes: seconds ? Math.round(seconds / 60) : null,
      resets_at: isoOrNull(window.reset_at, now, window.reset_after_seconds),
    });
  }
  return snapshot(windows, rateLimit.limit_reached === true || rateLimit.allowed === false, now);
}

const CLAUDE_WINDOWS: Record<string, number | null> = { five_hour: 300, seven_day: 7 * 24 * 60, seven_day_opus: 7 * 24 * 60, seven_day_sonnet: 7 * 24 * 60 };

/** Claude's `oauth/usage` body: `{ five_hour, seven_day, seven_day_opus, … }`, `utilization` 0–100. */
export function claudeUsageFromBody(body: unknown, now = Date.now()): SubscriptionUsage | null {
  if (!body || typeof body !== 'object') return null;
  const windows: UsageEndpointWindow[] = [];
  for (const [name, minutes] of Object.entries(CLAUDE_WINDOWS)) {
    const window = (body as Record<string, { utilization?: unknown; resets_at?: unknown } | null>)[name];
    if (!window || typeof window.utilization !== 'number') continue;
    // A model-specific weekly window keeps its own id; only `seven_day` is `weekly`.
    windows.push({
      fallback: name === 'seven_day' ? 'weekly' : name,
      used_percent: window.utilization,
      window_minutes: name === 'seven_day' || name === 'five_hour' ? minutes : null,
      resets_at: isoOrNull(window.resets_at, now),
    });
  }
  return snapshot(windows, false, now);
}

type UsageRow = Pick<typeof accountSecretResources.$inferSelect,
  'secretId' | 'accountId' | 'projectId' | 'providerId' | 'valueEnc' | 'createdBy' | 'updatedAt' | 'usage' | 'usageCheckedAt'>;

async function fetchJson(fetchImpl: FetchImpl, url: string, headers: Record<string, string>): Promise<unknown | null> {
  const response = await fetchImpl(url, { method: 'GET', headers, signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
  if (!response.ok) {
    logger.warn('[subscription-usage] the provider refused a usage read', { url, status: response.status });
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  return response.json().catch(() => null);
}

async function providerUsage(row: UsageRow, fetchImpl: FetchImpl): Promise<SubscriptionUsage | null> {
  if (row.providerId === 'claude-agent') {
    const token = readAccountSecret(row.accountId, row.secretId, row.valueEnc);
    if (!token) return null;
    const body = await fetchJson(fetchImpl, 'https://api.anthropic.com/api/oauth/usage', {
      authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', accept: 'application/json',
    });
    return claudeUsageFromBody(body);
  }
  // A login stored before project scoping has no project to refresh against:
  // its stored access token is used as is.
  const credential = await resolveCodexAccountCredential({
    projectId: row.projectId ?? '', accountId: row.accountId, sessionId: null, userId: row.createdBy,
    secretId: row.secretId, value: readAccountSecret(row.accountId, row.secretId, row.valueEnc), updatedAt: row.updatedAt,
    probe: !row.projectId,
  }, fetchImpl);
  if (!credential) return null;
  const headers: Record<string, string> = { authorization: `Bearer ${credential.access}`, 'user-agent': CODEX_USER_AGENT, accept: 'application/json' };
  if (credential.accountId) headers['chatgpt-account-id'] = credential.accountId;
  return codexUsageFromBody(await fetchJson(fetchImpl, 'https://chatgpt.com/backend-api/wham/usage', headers));
}

// replica-local: one provider read per login at a time on this replica.
const inflight = new Map<string, Promise<SubscriptionUsage | null>>();

/**
 * The login's current usage: the provider's answer when the last refresh is
 * over a minute old, else the stored snapshot. The minute is claimed in the
 * database first, so replicas and open tabs share one provider read.
 */
export async function refreshSubscriptionUsage(
  row: UsageRow, fetchImpl: FetchImpl = (input, init) => fetch(input, init),
): Promise<SubscriptionUsage | null> {
  const stored = storedSubscriptionUsage(row.usage);
  if (!row.providerId || !SUBSCRIPTION_PROVIDERS.has(row.providerId)) return null;
  const due = new Date(Date.now() - REFRESH_EVERY_MS);
  if (row.usageCheckedAt && row.usageCheckedAt > due) return stored;
  const running = inflight.get(row.secretId);
  if (running) return running;
  const pending = (async () => {
    const [claimed] = await db.update(accountSecretResources).set({ usageCheckedAt: new Date() })
      .where(and(
        eq(accountSecretResources.secretId, row.secretId),
        eq(accountSecretResources.accountId, row.accountId),
        sql`coalesce(${accountSecretResources.usageCheckedAt}, '-infinity') <= ${due.toISOString()}::timestamptz`,
      ))
      .returning({ secretId: accountSecretResources.secretId });
    if (!claimed) return stored;
    try {
      const fresh = await providerUsage(row, fetchImpl);
      if (!fresh) return stored;
      await recordSubscriptionUsage(row.secretId, row.accountId, fresh);
      return fresh;
    } catch (error) {
      logger.warn('[subscription-usage] usage refresh failed', { secretId: row.secretId, error: error instanceof Error ? error.message : String(error) });
      return stored;
    }
  })().finally(() => inflight.delete(row.secretId));
  inflight.set(row.secretId, pending);
  return pending;
}

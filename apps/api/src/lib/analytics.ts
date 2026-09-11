/**
 * Product analytics (PostHog) — the API's one funnel into posthog-node.
 *
 * Fire-and-forget, modeled on platform/services/provider-events.ts: never
 * awaited on a hot path, never throws into the caller, and a NO-OP when
 * `POSTHOG_KEY` is unset (local test profile, self-host). Event names stay a
 * closed set at the call sites; properties carry kinds, counts, ids and slugs
 * only — never secret values, file names, prompt text, emails or URLs.
 *
 * `distinctId` is the Kortix user id. `account` / `project` are PostHog groups
 * so account-level (B2B) analysis works without a person lookup.
 */
import { PostHog } from 'posthog-node';

import { normalizeAuditClientSource } from '../shared/audit-client-source';

type AnalyticsClient = Pick<PostHog, 'capture' | 'groupIdentify' | 'shutdown'>;

type PropertyValue = string | number | boolean | null | undefined;

export interface TrackInput {
  event: string;
  /** Kortix user id. Nothing is sent without one. */
  userId: string | null | undefined;
  accountId?: string | null;
  projectId?: string | null;
  sessionId?: string | null;
  properties?: Record<string, PropertyValue>;
}

// `undefined` = not resolved yet; `null` = resolved, disabled.
let client: AnalyticsClient | null | undefined;

function resolveClient(): AnalyticsClient | null {
  if (client !== undefined) return client;
  const key = process.env.POSTHOG_KEY?.trim();
  client = key
    ? new PostHog(key, {
        host: process.env.POSTHOG_HOST?.trim() || 'https://eu.i.posthog.com',
        // Long-lived Bun process: batch a little, flush every 10s at the latest.
        flushAt: 20,
        flushInterval: 10_000,
      })
    : null;
  return client;
}

/** Test seam. Pass `undefined` to re-resolve from the environment. */
export function setAnalyticsClientForTests(next: AnalyticsClient | null | undefined): void {
  client = next;
}

/** True when a capture would actually be sent. Lets callers skip work (a DB read) that only feeds analytics. */
export function isAnalyticsEnabled(): boolean {
  return resolveClient() !== null;
}

function cleanProperties(input?: Record<string, PropertyValue>): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(input ?? {})) if (v !== undefined) out[k] = v;
  return out;
}

export function track(input: TrackInput): void {
  try {
    const ph = resolveClient();
    if (!ph || !input.userId) return;
    const groups: Record<string, string> = {};
    if (input.accountId) groups.account = input.accountId;
    if (input.projectId) groups.project = input.projectId;
    ph.capture({
      distinctId: input.userId,
      event: input.event,
      properties: {
        // Dev, staging and prod share one PostHog project, so every event says
        // which deployment produced it; without it the dashboards mix test
        // traffic with customers. The web client registers the same property.
        environment: process.env.INTERNAL_KORTIX_ENV?.trim() || 'unknown',
        ...cleanProperties(input.properties),
        ...(input.sessionId ? { session_id: input.sessionId } : {}),
      },
      groups,
    });
  } catch (err) {
    console.warn('[analytics] capture failed (ignored):', (err as Error)?.message ?? err);
  }
}

/** Account-level facts (tier, …) for PostHog group analytics. */
export function identifyAccount(accountId: string, properties: Record<string, PropertyValue>): void {
  try {
    const ph = resolveClient();
    if (!ph || !accountId) return;
    ph.groupIdentify({ groupType: 'account', groupKey: accountId, properties: cleanProperties(properties) });
  } catch (err) {
    console.warn('[analytics] groupIdentify failed (ignored):', (err as Error)?.message ?? err);
  }
}

/**
 * Which surface sent the request. `X-Kortix-Client` (set by the SDK: `web`,
 * `cli`, …) wins; then the credential kind; then the user agent.
 */
export function requestSource(c: {
  req: { header(name: string): string | undefined };
  get(key: 'authType' | 'apiKeyType'): string | undefined;
}): string {
  const client = normalizeAuditClientSource(c.req.header('x-kortix-client'));
  if (client) return client;
  const authType = c.get('authType');
  const apiKeyType = c.get('apiKeyType');
  if (authType === 'apiKey' && apiKeyType === 'sandbox') return 'agent';
  if (authType === 'apiKey' || authType === 'pat') return 'api_key';
  if (authType === 'service_account') return 'automation';
  if (authType === 'oauth') return 'oauth';
  const ua = c.req.header('user-agent') ?? '';
  if (/kortix-cli|kortix\//i.test(ua)) return 'cli';
  if (/expo|okhttp|cfnetwork/i.test(ua)) return 'mobile';
  return 'web';
}

/** LLM-provider secret names → provider slug. Everything else is `null`. */
const PROVIDER_SECRET_NAMES: Record<string, string> = {
  ANTHROPIC_API_KEY: 'anthropic',
  OPENAI_API_KEY: 'openai',
  OPENROUTER_API_KEY: 'openrouter',
  AWS_BEDROCK_API_KEY: 'bedrock',
  GROQ_API_KEY: 'groq',
  OPENCODE_API_KEY: 'opencode',
};

export function providerForSecretName(name: string): string | null {
  return PROVIDER_SECRET_NAMES[name] ?? null;
}

/** Flush the queue on SIGTERM so the last batch is not lost on every rollout. */
export async function shutdownAnalytics(): Promise<void> {
  const ph = client;
  client = null;
  if (!ph) return;
  await ph.shutdown().catch((err) => console.warn('[analytics] shutdown failed (ignored):', err?.message ?? err));
}

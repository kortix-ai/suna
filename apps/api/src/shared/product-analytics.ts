/**
 * Product analytics from the API: the business events of the acquisition and
 * activation funnel, sent to the same PostHog project as the web app
 * (apps/web/src/lib/analytics/posthog-client.ts). The browser can lose events
 * to an ad blocker or a closed tab; these cannot be lost that way, and they
 * fire only after the database write succeeded.
 *
 * - The distinct id is the Supabase user id, the id the web app identifies
 *   with, so server and browser events land on one person and that person's
 *   first-touch campaign (`$initial_utm_*`, click ids) attributes them.
 * - Properties are kinds, amounts in USD and our own ids. Never a name, an
 *   email, a prompt, a file or anything a customer typed.
 * - Off unless POSTHOG_PROJECT_KEY is set: self-host, tests and local runs send
 *   nothing. Never throws, never awaits on a request path.
 * - Events that two code paths can both report (a subscription activated by
 *   checkout and by its first invoice) carry `dedupeKey`. It becomes a fixed
 *   event uuid, and PostHog keeps one event per uuid.
 */

import { createHash } from 'node:crypto';

import { PostHog } from 'posthog-node';

import { config } from '../config';
import { logger } from '../lib/logger';

export type ProductEvent =
  /** A personal account was created for a new user: the sign-up. */
  | 'account_created'
  /** A project was created or linked. `source`: provision | link. */
  | 'project_created'
  /** A person started a session. `source`: ui | mobile | cli | … */
  | 'session_created'
  /** A person sent a prompt to a session. */
  | 'message_sent'
  /** A Stripe checkout session was created. `kind`: subscription | credits. */
  | 'checkout_started'
  /** A paid subscription became active. `amount_usd` per month, `store`. */
  | 'subscription_started'
  /** A paid subscription ended and the account is back on free. */
  | 'subscription_canceled'
  /** A one-off credit purchase was paid. `amount_usd`, `store`. */
  | 'credits_purchased'
  /** A user joined an account through an invite. */
  | 'member_joined';

export type ProductEventProperties = Record<string, string | number | boolean | null | undefined>;

export interface ProductEventInput {
  /** The Supabase user id of the person the event belongs to. */
  userId: string;
  event: ProductEvent;
  accountId?: string;
  properties?: ProductEventProperties;
  /** Any stable string; the same key always yields the same event uuid. */
  dedupeKey?: string;
}

// replica-local: one client per process, created on first use.
let client: PostHog | null | undefined;

function analyticsClient(): PostHog | null {
  if (client !== undefined) return client;
  client = config.POSTHOG_PROJECT_KEY
    ? new PostHog(config.POSTHOG_PROJECT_KEY, {
        host: config.POSTHOG_HOST,
        flushAt: 20,
        flushInterval: 10_000,
        requestTimeout: 10_000,
        // Server events carry the API's address, not the visitor's.
        disableGeoip: true,
      })
    : null;
  return client;
}

/** A UUID (version 5 layout) derived from `key`. */
export function stableEventUuid(key: string): string {
  const hex = createHash('sha256').update(`kortix-product-event:${key}`).digest('hex');
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Queue one event. Returns at once; delivery is batched in the background. */
export function captureProductEvent(input: ProductEventInput): void {
  const posthog = analyticsClient();
  if (!posthog || !input.userId) return;
  try {
    posthog.capture({
      distinctId: input.userId,
      event: input.event,
      uuid: input.dedupeKey ? stableEventUuid(`${input.event}:${input.dedupeKey}`) : undefined,
      properties: {
        ...input.properties,
        account_id: input.accountId,
        // A local stack runs as INTERNAL_KORTIX_ENV=dev; keep it out of dev's numbers.
        environment: config.KORTIX_LOCAL_DEV ? 'local' : config.INTERNAL_KORTIX_ENV,
        $lib_custom: 'kortix-api',
      },
    });
  } catch (error) {
    logger.warn('[product-analytics] capture failed', {
      event: input.event,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Send what is queued. Called once by the shutdown sequence. */
export async function shutdownProductAnalytics(): Promise<void> {
  if (!client) return;
  await client.shutdown(5_000).catch(() => {});
}

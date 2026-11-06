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

/**
 * The event contract. Names and properties follow the dashboards in
 * infra/posthog/dashboards.tf: change an event here, change the insight there.
 */
export type ProductEvent =
  // Acquisition and activation
  /** A new person reached Kortix for the first time (accounts/core/signup-event.ts). `method`: auth provider. */
  | 'user_signed_up'
  /** A CLI or device login completed. `method`. */
  | 'user_logged_in'
  /** A project was created. `origin`: blank | template | marketplace | github_import. */
  | 'project_created'
  /** A person created a session (not a trigger, channel or agent). `source`. */
  | 'session_created'
  /** A session's sandbox started for a person. `provider`, `boot_ms`, `stage`. */
  | 'session_started'
  /** A person restarted a session. `provider`. */
  | 'session_restarted'
  /** A session's sandbox stopped. `reason`, `active_ms`. */
  | 'session_stopped'
  /** A person sent a prompt. `model`, `attachment_count`, `source`. */
  | 'prompt_sent'
  /** An agent turn ended. `status`: ok | error | aborted, `end_reason`, `duration_ms`. */
  | 'turn_completed'
  // Setup and adoption
  /** A project secret was saved. `name_kind`: provider | other. Never the name or value. */
  | 'secret_created'
  /** An LLM provider was connected. `provider`, `method`: api_key | oauth | subscription. */
  | 'provider_configured'
  /** A provider credential was checked. `provider`, `state`. */
  | 'provider_verified'
  /** A person switched a session's model. `from`, `to`. */
  | 'model_changed'
  /** A connector was added to a project. `provider`, `slug` (the app, e.g. gmail). */
  | 'connector_added'
  /** A connector finished connecting. `slug`, `method`: credential | oauth. */
  | 'connector_connected'
  /** A trigger was created. */
  | 'trigger_created'
  /** A trigger fired. `fire_source`: manual | cron | webhook, `deduped`. */
  | 'trigger_fired'
  /** An app was deployed. `app_kind`, `hosting_provider`. */
  | 'app_deployed'
  /** A project feature flag was toggled. `key`, `enabled`. */
  | 'feature_flag_toggled'
  /** A user joined an account by invite. `via`, `role`. */
  | 'member_joined'
  // Revenue
  /** A request was refused for billing. `reason`, `where`. */
  | 'billing_gate_hit'
  /** A Stripe checkout was created. `kind`: subscription | credits, `tier`, `amount_usd`. */
  | 'checkout_started'
  /** A paid plan became active. `tier`, `amount_usd` per month, `store`, `via`. */
  | 'subscription_activated'
  /** A paid plan ended. `store`, `previous_tier`, `amount_usd`. */
  | 'subscription_cancelled'
  /** A one-off credit purchase was paid. `amount_usd`, `store`. */
  | 'credits_topped_up';

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
        // The web client's names: `production`, `staging`, `dev`, `local`.
        environment: config.KORTIX_LOCAL_DEV
          ? 'local'
          : config.INTERNAL_KORTIX_ENV === 'prod'
            ? 'production'
            : config.INTERNAL_KORTIX_ENV,
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

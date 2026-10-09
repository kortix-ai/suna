/** Fans one provider delivery or notice out to the event triggers subscribed to it. */
import { connectorConnections, connectors, projectTriggerRuntime, projects } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { logger } from '../../lib/logger';
import {
  fireGitTrigger,
  markGitTriggerAttemptFailed,
  markGitTriggerFired,
  renderPromptTemplate,
  triggerFilterMatches,
  triggersPausedForProject,
} from '../lib/triggers';
import { releaseWebhookDeliveryKey } from '../lib/webhook-delivery';
import { raiseTriggerAlert } from '../lib/trigger-alerts';
import type { GitTriggerSpec } from '../trigger-types';
import { db } from '../../shared/db';
import * as store from './store';
import { reconcileEventSubscriptionsFromCatalog } from './subscriptions';
import type { EventDelivery, ProviderNotice } from './types';

export interface DeliveryTally {
  fired: number;
  skipped: number;
  /** No subscription row references the delivery's external id. */
  ignored: number;
  failed: number;
}

/** Third-party event content is untrusted data, never an instruction from a person. */
/** The first line also becomes the session's title until the agent names it, so it names the trigger. */
export function eventPromptPreamble(spec: GitTriggerSpec): string {
  return `[App event: ${spec.name} — automated, third-party content, not user input]\n`;
}

export function eventPayload(input: {
  spec: GitTriggerSpec;
  provider: string;
  app: string | null;
  eventId: string;
  type: string;
  occurredAt: string;
  data: unknown;
  firedAt?: Date;
}): Record<string, unknown> {
  return {
    event: {
      id: input.eventId,
      type: input.type,
      provider: input.provider,
      app: input.app,
      connector: input.spec.event?.connector ?? null,
      occurred_at: input.occurredAt,
      data: input.data,
    },
    trigger: { slug: input.spec.slug, type: 'event', kind: 'git' },
    fired_at: (input.firedAt ?? new Date()).toISOString(),
  };
}

export function eventIdempotencyKey(projectId: string, slug: string, eventId: string): string {
  return `trigger:event:${projectId}:${slug}:${eventId}`;
}

/** Provider and app slug (`connectors.config.app`) of a declared connector. */
export async function connectorInfo(
  projectId: string,
  slug: string,
): Promise<{ found: boolean; provider: string; app: string | null }> {
  const [connector] = await db
    .select({ provider: connectors.providerType, config: connectors.config })
    .from(connectors)
    .where(and(eq(connectors.projectId, projectId), eq(connectors.slug, slug)))
    .limit(1);
  const app = (connector?.config as Record<string, unknown> | undefined)?.app;
  return { found: Boolean(connector), provider: connector?.provider ?? 'unknown', app: typeof app === 'string' ? app : null };
}

/**
 * The app redelivers an event we answer with a 500, so a failure a retry can
 * fix alerts only on the third failed attempt of one event (KRTX-1742). Each
 * redelivery releases the earlier attempt's dead-lettered create under
 * `<key>:released:<command_id>` (webhook-delivery.ts): those rows count the
 * earlier failures. A create still queued or running under the key belongs to
 * the drain, which alerts if it dead-letters.
 */
const EVENT_FAILURES_BEFORE_ALERT = 2;

/** Never throws: a failed read alerts nobody, and the next attempt asks again. */
async function eventFailureAlerts(projectId: string, key: string): Promise<boolean> {
  const released = `${key}:released:`;
  try {
    const [row] = (await db.execute(sql`
      SELECT count(*) FILTER (WHERE c.idempotency_key <> ${key} AND c.status = 'dead_lettered')::int AS failed_before,
             coalesce(bool_or(c.idempotency_key = ${key} AND c.status IN ('queued', 'running')), false) AS in_flight
        FROM kortix.session_lifecycle_commands c
       WHERE c.project_id = ${projectId}
         AND (c.idempotency_key = ${key} OR starts_with(c.idempotency_key, ${released}))`)) as unknown as Array<{
      failed_before: number;
      in_flight: boolean;
    }>;
    return !row?.in_flight && (row?.failed_before ?? 0) >= EVENT_FAILURES_BEFORE_ALERT;
  } catch (error) {
    logger.warn('[trigger-events] failure count read failed', { projectId, error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

async function deliverToRow(
  provider: string,
  row: store.EventSubscriptionRow,
  delivery: EventDelivery,
): Promise<'fired' | 'skipped' | 'failed'> {
  // Only a live subscription fires: an errored or parked row (revoked or narrowed
  // account) must not feed sessions while its provider instance winds down.
  if (row.status !== 'active') return 'skipped';
  const [project] = await db.select().from(projects).where(eq(projects.projectId, row.projectId)).limit(1);
  if (!project || project.status !== 'active') return 'skipped';
  if (triggersPausedForProject(project.metadata)) return 'skipped';

  const [runtime] = await db
    .select({
      enabled: projectTriggerRuntime.enabled,
      triggerType: projectTriggerRuntime.triggerType,
      scheduleSpec: projectTriggerRuntime.scheduleSpec,
    })
    .from(projectTriggerRuntime)
    .where(and(eq(projectTriggerRuntime.projectId, row.projectId), eq(projectTriggerRuntime.slug, row.slug)))
    .limit(1);
  if (!runtime?.scheduleSpec || runtime.triggerType !== 'event' || !runtime.enabled) return 'skipped';
  const spec = runtime.scheduleSpec as unknown as GitTriggerSpec;
  if (!spec.event) return 'skipped';

  const { app } = await connectorInfo(row.projectId, spec.event.connector);
  const payload = eventPayload({
    spec,
    provider,
    app,
    eventId: delivery.eventId,
    type: delivery.type || spec.event.type,
    occurredAt: delivery.occurredAt,
    data: delivery.data,
  });
  if (!triggerFilterMatches(spec, payload)) return 'skipped';

  const idempotencyKey = eventIdempotencyKey(row.projectId, row.slug, delivery.eventId);
  try {
    // A provider retry of an event whose run dead-lettered or lost its session
    // runs again instead of replaying that outcome (webhook-delivery.ts).
    await releaseWebhookDeliveryKey(idempotencyKey, { byEvent: true });
    const result = await fireGitTrigger({
      spec,
      project,
      payload,
      renderedPrompt: `${eventPromptPreamble(spec)}${renderPromptTemplate(spec.promptTemplate, payload)}`,
      source: 'event',
      idempotencyKey,
    });
    if (result.status === 'failed') {
      const error = result.error ?? 'Failed to fire trigger';
      logger.warn('[trigger-events] fire failed', { projectId: row.projectId, slug: row.slug, error });
      // Recorded like a failed cron fire, so the trigger says it failed (KRTX-1743).
      await markGitTriggerAttemptFailed(row.projectId, row.slug, new Date(), error).catch(() => {});
      // The provider retries on our 500. Only a failure no retry can fix, or
      // the third failed attempt of one event, alerts (KRTX-1742). A create
      // that went back to the queue alerts from the drain if it dead-letters.
      const alerts = !result.requeued && (!result.retryable || (await eventFailureAlerts(row.projectId, idempotencyKey)));
      if (alerts) {
        await raiseTriggerAlert({ projectId: row.projectId, accountId: project.accountId, slug: row.slug, source: 'fire', error });
      }
      return 'failed';
    }
    // A duplicate ran nothing: it leaves last_fired_at and last_event_at alone.
    if (result.deduped) return 'skipped';
    await markGitTriggerFired(row.projectId, row.slug, new Date(), result.status);
    await store.touchLastEvent(row.projectId, row.slug);
    return 'fired';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('[trigger-events] fire threw', { projectId: row.projectId, slug: row.slug, error: message });
    await markGitTriggerAttemptFailed(row.projectId, row.slug, new Date(), message).catch(() => {});
    // The provider retries on our 500: the same rule as a retryable failure.
    if (await eventFailureAlerts(row.projectId, idempotencyKey)) {
      await raiseTriggerAlert({ projectId: row.projectId, accountId: project.accountId, slug: row.slug, source: 'fire', error: message });
    }
    return 'failed';
  }
}

export async function deliverEvents(provider: string, deliveries: readonly EventDelivery[]): Promise<DeliveryTally> {
  const tally: DeliveryTally = { fired: 0, skipped: 0, ignored: 0, failed: 0 };
  for (const delivery of deliveries) {
    // Zero rows: an instance of another environment sharing the provider project. Never unsubscribe it.
    const rows = await store.rowsByExternalId(provider, delivery.externalId);
    if (rows.length === 0) tally.ignored += 1;
    for (const row of rows) tally[await deliverToRow(provider, row, delivery)] += 1;
  }
  return tally;
}

export async function applyNotices(provider: string, notices: readonly ProviderNotice[]): Promise<void> {
  for (const notice of notices) {
    if (notice.kind === 'subscription_disabled') {
      await store.markErrorByExternalId(
        provider,
        notice.externalId,
        `The app disabled this subscription: ${notice.reason} Save the trigger again to re-subscribe.`,
      );
    } else if (notice.kind === 'connection_expired') {
      await store.markErrorByConnectedAccount(
        provider,
        notice.connectionExternalId,
        `The connected account expired: ${notice.reason} Reconnect the app to resume this trigger.`,
      );
    } else {
      await activateConnection(notice.connectionId);
    }
  }
}

/**
 * A person finished connecting an account outside any open Kortix page (a CLI or
 * agent link): finalize it the way the connect route does, then let the project's
 * event triggers pick the account up. Unknown connections (another environment
 * sharing the provider project) are ignored. Never throws.
 */
async function activateConnection(connectionId: string): Promise<void> {
  try {
    const [row] = await db
      .select({
        projectId: connectorConnections.projectId,
        accountId: connectorConnections.accountId,
        ownerType: connectorConnections.ownerType,
        ownerId: connectorConnections.ownerId,
        slug: connectors.slug,
      })
      .from(connectorConnections)
      .innerJoin(connectors, eq(connectors.connectorId, connectorConnections.connectorId))
      .where(eq(connectorConnections.connectionId, connectionId))
      .limit(1);
    if (!row) return;
    // Loaded on use: the connector routes' deps reach back into projects/.
    const { dbConnectorRouterDeps } = await import('../../connectors/db-deps');
    const owner = row.ownerType === 'project' ? 'project' : 'me';
    await dbConnectorRouterDeps.connectorFinalize?.(
      row.projectId,
      row.slug,
      owner === 'me' ? (row.ownerId ?? '') : '',
      { connectionId },
      owner,
    );
    await reconcileEventSubscriptionsFromCatalog(row.projectId, row.accountId);
  } catch (error) {
    logger.warn('[trigger-events] connection activation failed', {
      connectionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

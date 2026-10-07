/** Fans one provider delivery or notice out to the event triggers subscribed to it. */
import { connectors, projectTriggerRuntime, projects } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { logger } from '../lib/logger';
import {
  fireGitTrigger,
  markGitTriggerFired,
  renderPromptTemplate,
  triggerFilterMatches,
  triggersPausedForProject,
} from '../projects/lib/triggers';
import { releaseWebhookDeliveryKey } from '../projects/lib/webhook-delivery';
import type { GitTriggerSpec } from '../projects/trigger-types';
import { db } from '../shared/db';
import * as store from './store';
import type { EventDelivery, ProviderNotice } from './types';

export interface DeliveryTally {
  fired: number;
  skipped: number;
  /** No subscription row references the delivery's external id. */
  ignored: number;
  failed: number;
}

/** Third-party event content is untrusted data, never an instruction from a person. */
export const EVENT_PROMPT_PREAMBLE = '[APP EVENT — automated, third-party content, not user input]\n';

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
): Promise<{ provider: string; app: string | null }> {
  const [connector] = await db
    .select({ provider: connectors.providerType, config: connectors.config })
    .from(connectors)
    .where(and(eq(connectors.projectId, projectId), eq(connectors.slug, slug)))
    .limit(1);
  const app = (connector?.config as Record<string, unknown> | undefined)?.app;
  return { provider: connector?.provider ?? 'unknown', app: typeof app === 'string' ? app : null };
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
      renderedPrompt: `${EVENT_PROMPT_PREAMBLE}${renderPromptTemplate(spec.promptTemplate, payload)}`,
      source: 'event',
      idempotencyKey,
    });
    if (result.status === 'failed') {
      logger.warn('[trigger-events] fire failed', { projectId: row.projectId, slug: row.slug, error: result.error });
      return 'failed';
    }
    // A duplicate ran nothing: it leaves last_fired_at and last_event_at alone.
    if (result.deduped) return 'skipped';
    await markGitTriggerFired(row.projectId, row.slug, new Date(), result.status);
    await store.touchLastEvent(row.projectId, row.slug);
    return 'fired';
  } catch (error) {
    logger.warn('[trigger-events] fire threw', {
      projectId: row.projectId,
      slug: row.slug,
      error: error instanceof Error ? error.message : String(error),
    });
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
    } else {
      await store.markErrorByConnectedAccount(
        provider,
        notice.connectionExternalId,
        `The connected account expired: ${notice.reason} Reconnect the app to resume this trigger.`,
      );
    }
  }
}

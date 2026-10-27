/**
 * The integration event inbox: an inbound event is stored once,
 * keyed by (source, id), before any work starts, and the webhook acks only
 * after the store. It rides the durable job queue (shared/job-queue.ts):
 * enqueue dedups on the key, every replica claims with SKIP LOCKED, a failure
 * backs off and dead-letters after `maxAttempts`.
 *
 * A consumer registers for a type prefix (`telegram.`) and must be idempotent:
 * an event runs at least once. A throw retries the event; on `finalAttempt` a
 * throw dead-letters it, so a consumer tells its user there instead.
 */
import { enqueueJob, registerJobHandler } from '../shared/job-queue';

export const INTEGRATION_EVENTS_QUEUE = 'integration.events';

/** The envelope: CloudEvents-shaped, plus the project the source belongs to. */
export interface IntegrationEvent {
  /** The upstream event id; the dedup key together with `source`. */
  id: string;
  /** The emitting install, e.g. `telegram:<bot id>`. */
  source: string;
  /** `<integration>.<object>.<verb>`, e.g. `telegram.message.created`. */
  type: string;
  time: string;
  /** Routing key for threads and keyed sessions, e.g. a chat id. */
  subject: string | null;
  projectId: string;
  data: Record<string, unknown>;
}

export type EventConsumer = (event: IntegrationEvent, run: { finalAttempt: boolean }) => Promise<void>;

// replica-local: consumers are code, registered at import on every replica.
const consumers = new Map<string, EventConsumer>();

export function registerEventConsumer(typePrefix: string, consumer: EventConsumer): void {
  consumers.set(typePrefix, consumer);
}

/**
 * Store an event. False when (source, id) was already stored: a provider retry
 * or a duplicate delivery. Throws when the store fails, so the webhook answers
 * 5xx and the provider retries.
 */
export function emitIntegrationEvent(
  event: IntegrationEvent,
  opts: { maxAttempts?: number } = {},
): Promise<boolean> {
  return enqueueJob(
    INTEGRATION_EVENTS_QUEUE,
    `${event.source}:${event.id}`,
    event as unknown as Record<string, unknown>,
    { maxAttempts: opts.maxAttempts },
  );
}

export async function dispatchIntegrationEvent(
  event: IntegrationEvent,
  run: { finalAttempt: boolean } = { finalAttempt: false },
): Promise<void> {
  for (const [prefix, consumer] of consumers) {
    if (event.type.startsWith(prefix)) return consumer(event, run);
  }
  throw new Error(`no consumer for integration event type ${event.type}`);
}

registerJobHandler(
  INTEGRATION_EVENTS_QUEUE,
  (job) =>
    dispatchIntegrationEvent(job.payload as unknown as IntegrationEvent, {
      finalAttempt: job.attempts >= job.maxAttempts,
    }),
  2 * 60_000,
);

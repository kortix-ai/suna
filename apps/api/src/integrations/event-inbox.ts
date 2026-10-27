/**
 * The integration event inbox: an inbound event is stored once,
 * keyed by (source, id), before any work starts, and the webhook acks only
 * after the store. It rides the durable job queue (shared/job-queue.ts):
 * enqueue dedups on the key, every replica claims with SKIP LOCKED, a failure
 * backs off and dead-letters after `maxAttempts`.
 *
 * Each integration's events have their own queue, and its consumer is that
 * queue's handler. A consumer must be idempotent: an event runs at least once.
 * A throw retries the event; on `finalAttempt` a throw dead-letters it, so a
 * consumer tells its user there instead.
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

/**
 * The queue of an integration's events. Telegram keeps the shared queue (its
 * rows are already there). Every other integration has its own, so a replica
 * on older code, which has no consumer for it, never claims its events.
 */
function queueOf(type: string): string {
  const integration = type.split('.')[0];
  return integration === 'telegram' ? INTEGRATION_EVENTS_QUEUE : `${INTEGRATION_EVENTS_QUEUE}.${integration}`;
}

/**
 * Consume one integration's events (`typePrefix`: `<integration>.`).
 * `visibilityMs` must exceed the consumer's worst run; `batch`: its events
 * running at once on a replica (default: the replica's limit).
 */
export function registerEventConsumer(
  typePrefix: string,
  consumer: EventConsumer,
  opts: { visibilityMs?: number; batch?: number } = {},
): void {
  registerJobHandler(
    queueOf(typePrefix),
    (job) => consumer(job.payload as unknown as IntegrationEvent, { finalAttempt: job.attempts >= job.maxAttempts }),
    opts.visibilityMs ?? 2 * 60_000,
    opts.batch,
  );
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
    queueOf(event.type),
    `${event.source}:${event.id}`,
    event as unknown as Record<string, unknown>,
    { maxAttempts: opts.maxAttempts },
  );
}

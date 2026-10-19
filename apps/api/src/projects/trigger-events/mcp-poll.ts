/**
 * The checks of the `mcp` event source. Every replica claims due poll streams
 * (SKIP LOCKED, a 3-minute lease fenced by `claim`), calls one read-only MCP
 * tool through the connector gateway as the account owner, and turns new
 * items into deliveries. A check commits its deliveries and its new state in
 * one transaction, and only while it still holds the claim. Deliveries run on
 * their own queue through the unchanged `deliverEvents`, so a failed fire
 * retries without calling the vendor again.
 */
import { connectors, projectTriggerRuntime, projects } from '@kortix/db';
import { and, eq, inArray } from 'drizzle-orm';
import type { ExecutionRecord, GatewayDeps } from '../../connectors/gateway';
import { resolveFeatureFlag } from '../../feature-flags/registry';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import { enqueueJobs, registerJobHandler } from '../../shared/job-queue';
import { clearTriggerAlert, raiseTriggerAlert } from '../lib/trigger-alerts';
import { triggersPausedForProject } from '../lib/triggers';
import { resolveProjectAutomationActor } from '../session-lifecycle/actor';
import type { GitTriggerSpec } from '../trigger-types';
import { deliverEvents } from './deliver';
import { eventTriggersEnabled } from './flag';
import {
  type EventDefinition,
  MAX_FIRES_PER_HOUR,
  MAX_ITEMS_PER_CHECK,
  type PollItem,
  boundData,
  eventIdOf,
  floorFor,
  intervalSeconds,
  nextPageToken,
  parseToolOutput,
  planCheck,
} from './mcp-events';
import { CALL_TIMEOUT_MS, type Outcome, backoffMs, classifyCall } from './mcp-outcome';
import { MCP_SOURCE_ID, appLabel, connectorEventApp, definitionFor, toolProblem } from './mcp-source';
import {
  type PollErrorKind,
  type PollStream,
  type StreamPatch,
  RECORD_FIRST,
  claimDueStreams,
  delayConnectionStreams,
  deleteStream,
  setRowsStatus,
  settleStream,
  streamRows,
} from './poll-store';
import { reconcileEventSubscriptionsFromCatalog, resolveSource } from './subscriptions';
import type { EventDelivery } from './types';

export const DELIVER_QUEUE = 'trigger-events.deliver';
const DELIVER_MAX_ATTEMPTS = 5;
export const CLAIM_LIMIT = 8;
const LEASE_MS = 3 * 60_000;
const DEFERRED_RECHECK_MS = 15_000;
const HOUR_MS = 60 * 60_000;
const oneLine = (text: string, max = 300): string => text.replace(/\s+/g, ' ').trim().slice(0, max);
/** Transient failures in a row before the triggers say so. Checks continue. */
const FAILURES_BEFORE_ROW_ERROR = 3;
/** A stream no trigger references is deleted only after this: its subscribe may still be writing the trigger row. */
const ORPHAN_GRACE_MS = 10 * 60_000;
/** A parked stream (a person must act) retries this often on its own; a reconnect re-arms it at once. */
const PARK_RETRY_MS = HOUR_MS;
/** Checks one replica runs at once. A slow vendor holds one slot, not the batch. */
const CAPACITY = 8;

const jittered = (ms: number): number => Math.round(ms * (1 + Math.random() * 0.1));

class StaleClaimError extends Error {}

/** Park (needs a person) or back off (transient), and tell the triggers. */
async function settleFailure(stream: PollStream, outcome: Exclude<Outcome, { kind: 'ok' }>, label: string, now: number): Promise<void> {
  const failures = stream.failures + 1;
  const intervalMs = stream.intervalSeconds * 1000;
  const transient = outcome.kind === 'transient';
  const message = transient && failures >= FAILURES_BEFORE_ROW_ERROR
    ? `The last ${failures} checks of ${label} failed: ${outcome.message} Kortix keeps checking, at most 1 hour apart.`
    : outcome.message;
  const nextPollAt = new Date(now + (transient ? backoffMs(intervalMs, failures, outcome.retryAfterSeconds) : PARK_RETRY_MS));
  const settled = await settleStream(stream, {
    failures,
    lastError: message,
    lastErrorKind: outcome.kind,
    nextPollAt,
    // A parked stream's triggers are not live: the check that un-parks it records first and fires nothing.
    ...(transient ? {} : { primedAt: null, fireAfter: RECORD_FIRST }),
  });
  if (!settled) return;
  logger.info('[trigger-events/poll] check failed', { externalId: stream.externalId, kind: outcome.kind, failures });
  if (transient && outcome.message.endsWith('limited the request rate.')) {
    await delayConnectionStreams(stream.connectionId, nextPollAt);
  }
  if (transient && failures < FAILURES_BEFORE_ROW_ERROR) return;
  const changed = await setRowsStatus(stream.externalId, outcome.kind === 'needs_connection' ? 'needs_connection' : 'error', message, stream.lastError);
  for (const row of changed) {
    await raiseTriggerAlert({ projectId: row.projectId, accountId: row.accountId, slug: row.slug, source: 'fire', error: message });
  }
}

/**
 * Skip this check without a vendor call. Never a park: the triggers stay
 * `active`, so the reconciler would skip them and never re-arm a parked
 * stream. A stream parks only in `settleFailure`, which moves its triggers
 * off `active` in the same step.
 */
async function skip(stream: PollStream, now: number, reprime: boolean): Promise<void> {
  await settleStream(stream, {
    // Nothing from the skipped window fires: the next check records it.
    ...(reprime ? { primedAt: null, fireAfter: RECORD_FIRST } : {}),
    nextPollAt: new Date(now + stream.intervalSeconds * 1000),
  });
}

async function triggerSpecs(projectId: string, slugs: string[]): Promise<GitTriggerSpec[]> {
  const rows = await db
    .select({ spec: projectTriggerRuntime.scheduleSpec })
    .from(projectTriggerRuntime)
    .where(and(eq(projectTriggerRuntime.projectId, projectId), inArray(projectTriggerRuntime.slug, slugs)));
  return rows.flatMap((r) => ((r.spec as unknown as GitTriggerSpec | null)?.event ? [r.spec as unknown as GitTriggerSpec] : []));
}

interface Loaded {
  def: EventDefinition;
  label: string;
  owner: string;
  metadata: unknown;
  /** The shortest interval of the triggers on this stream: a shared check serves the fastest one. */
  intervalSeconds: number;
}

/**
 * Everything a check needs, or the reason it must not call the vendor. Parks,
 * deletes or re-arms the stream itself when it returns null.
 */
async function load(stream: PollStream, now: number): Promise<Loaded | null> {
  const rows = await streamRows(stream.externalId);
  if (rows.length === 0) {
    // The reconciler deletes a stream it stops referencing; this is the backstop for a leak.
    if (now - stream.createdAt.getTime() > ORPHAN_GRACE_MS) await deleteStream(stream.externalId);
    else await skip(stream, now, false);
    return null;
  }
  const [project] = await db
    .select({ status: projects.status, metadata: projects.metadata })
    .from(projects)
    .where(eq(projects.projectId, stream.projectId))
    .limit(1);
  // A flag turned off releases or reconciles the triggers, which deletes the stream; until then, no check.
  // Paused, or no trigger left that a check can serve: no check either. The first check after
  // that records what is there, so skipped events do not queue.
  const consumers = rows.filter((r) => r.status === 'active' || (stream.lastError !== null && r.lastError === stream.lastError));
  if (
    !project ||
    project.status !== 'active' ||
    !eventTriggersEnabled(project.metadata) ||
    !resolveFeatureFlag(project.metadata, 'connectors_v2') ||
    triggersPausedForProject(project.metadata) ||
    consumers.length === 0
  ) {
    await skip(stream, now, true);
    return null;
  }
  // The reconciler owns the account check (revoked, narrowed to people, another default):
  // when the account no longer resolves to this stream, it re-decides every trigger on it.
  const specs = await triggerSpecs(stream.projectId, consumers.map((r) => r.slug));
  const spec = specs[0];
  const resolved = spec?.event ? await resolveSource(stream.projectId, stream.accountId, spec.event, project.metadata) : null;
  if (!resolved || resolved.kind !== 'ok' || resolved.connection.connectionId !== stream.connectionId) {
    // Same resolveSource as the reconciler: it moves the triggers and drops or replaces this stream.
    await skip(stream, now, false);
    await reconcileEventSubscriptionsFromCatalog(stream.projectId, stream.accountId);
    return null;
  }
  const [connector] = await db
    .select({ connectorId: connectors.connectorId, slug: connectors.slug, provider: connectors.providerType, config: connectors.config })
    .from(connectors)
    .where(and(eq(connectors.projectId, stream.projectId), eq(connectors.slug, stream.connectorSlug)))
    .limit(1);
  const app = connector ? connectorEventApp(connector) : null;
  if (!connector || !app || connector.provider !== MCP_SOURCE_ID) {
    await settleFailure(stream, { kind: 'fatal', message: `Connector "${stream.connectorSlug}" is not an MCP app any more.` }, stream.connectorSlug, now);
    return null;
  }
  const label = appLabel(app);
  const { def, tools } = await definitionFor(stream.eventType, connector.connectorId, app);
  if (tools.length === 0) {
    await settleFailure(stream, { kind: 'transient', message: `Kortix has not read the tools of ${label} yet.` }, label, now);
    return null;
  }
  if (!def) {
    await settleFailure(stream, { kind: 'fatal', message: `Unknown event ${stream.eventType} for ${stream.connectorSlug}. Run kortix triggers events --connector ${stream.connectorSlug}.` }, label, now);
    return null;
  }
  const problem = toolProblem(def, tools, label);
  if (problem) {
    await settleFailure(stream, { kind: 'fatal', message: problem }, label, now);
    return null;
  }
  const owner = await resolveProjectAutomationActor(stream.accountId);
  if (!owner) {
    await settleFailure(stream, { kind: 'fatal', message: `This account has no owner for Kortix to check ${label} as.` }, label, now);
    return null;
  }
  const shortest = Math.min(...specs.map((s) => intervalSeconds(s.event!.config ?? {})));
  return { def, label, owner, metadata: project.metadata, intervalSeconds: Number.isFinite(shortest) ? shortest : stream.intervalSeconds };
}

/**
 * Gateway deps for one check: sessionless, as the owner, on the stream's
 * account. Only read tools resolve. A pending approval writes no approval
 * row (a trigger cannot wait for one), and successful calls are held back:
 * the check writes one `ok` audit row only when it fires something.
 */
async function checkDeps(
  stream: PollStream,
  owner: string,
  okRecords: ExecutionRecord[],
): Promise<{ deps: GatewayDeps; writeAudit: GatewayDeps['recordExecution'] }> {
  const { makeDbGatewayDeps } = await import('../../connectors/db-deps-gateway');
  const base = makeDbGatewayDeps({
    userId: owner,
    accountId: stream.accountId,
    projectId: stream.projectId,
    sessionId: null,
    subject: { userId: owner, groupIds: [] },
    agentGrant: null,
    requestedConnectorAccount: stream.connectionId,
    // What a check reads reaches every session its triggers open: only what the whole project may use.
    secretsAsProject: true,
  });
  const origin = { origin: 'event_poll', external_id: stream.externalId };
  const deps: GatewayDeps = {
    ...base,
    callTimeoutMs: CALL_TIMEOUT_MS,
    loadAction: async (connectorId, relPath, providerType) => {
      const action = await base.loadAction(connectorId, relPath, providerType);
      return action?.risk === 'read' ? action : null;
    },
    recordExecution: async (rec) => {
      if (rec.status === 'pending_approval') return null;
      const tagged = { ...rec, resultSummary: { ...(rec.resultSummary ?? {}), ...origin } };
      if (rec.status === 'ok') {
        okRecords.push(tagged);
        return null;
      }
      return base.recordExecution(tagged);
    },
  };
  return { deps, writeAudit: (rec) => base.recordExecution(rec) };
}

/** One check of one claimed stream. Never throws. */
export async function runPoll(stream: PollStream, now = Date.now()): Promise<void> {
  try {
    await check(stream, now);
  } catch (error) {
    if (error instanceof StaleClaimError) return;
    const message = oneLine(error instanceof Error ? error.message : String(error));
    logger.warn('[trigger-events/poll] check threw', { externalId: stream.externalId, error: message });
    await settleFailure(stream, { kind: 'transient', message: `The check failed: ${message}` }, appLabel(stream.connectorSlug), now).catch(() => {});
  }
}

async function check(claimed: PollStream, now: number): Promise<void> {
  const loaded = await load(claimed, now);
  if (!loaded) return;
  const { def, label, owner } = loaded;
  const stream: PollStream = { ...claimed, intervalSeconds: loaded.intervalSeconds };
  const okRecords: ExecutionRecord[] = [];
  const { deps, writeAudit } = await checkDeps(stream, owner, okRecords);
  const { handleCall } = await import('../../connectors/gateway');
  const floor = floorFor(stream.fireAfter.getTime(), now);
  let request;
  try {
    request = def.request(stream.config, { now, floor });
  } catch (error) {
    await settleFailure(stream, { kind: 'fatal', message: error instanceof Error ? error.message : String(error) }, label, now);
    return;
  }

  const items: PollItem[] = [];
  const known = new Set(stream.seen);
  let pageToken: string | null = null;
  let reachedKnown = false;
  for (let page = 0; page < request.maxPages && items.length < MAX_ITEMS_PER_CHECK; page++) {
    const result = await handleCall(deps, {
      projectId: stream.projectId,
      accountId: stream.accountId,
      subject: { userId: owner, groupIds: [] },
      sessionId: null,
      connectorSlug: stream.connectorSlug,
      actionPath: def.tool,
      args: { ...request.args, ...(pageToken ? { pageToken } : {}) },
    });
    const outcome = classifyCall(result, label, stream.connectorSlug, def.tool);
    if (outcome.kind !== 'ok') {
      // An MCP isError reaches the vendor and answers 2xx: its held ok row is written as the error it is.
      const held = okRecords.at(-1);
      if (result.status === 'ok' && held) {
        await writeAudit({ ...held, status: 'error', resultSummary: { ...(held.resultSummary ?? {}), upstream_error: outcome.message } }).catch(() => null);
      }
      await settleFailure(stream, outcome, label, now);
      return;
    }
    const output = result.status === 'ok' ? result.output : null;
    const pageItems = def.items(output);
    if (!pageItems) {
      await settleFailure(stream, { kind: 'transient', message: `${def.tool} answered without a list of items.` }, label, now);
      return;
    }
    // Keys go into `seen` and into idempotency keys: bounded and safe.
    items.push(...pageItems.map((item) => ({ ...item, key: eventIdOf(item.key) })));
    pageToken = nextPageToken(parseToolOutput(output));
    reachedKnown = pageItems.some((item) => known.has(eventIdOf(item.key)) || (item.time !== null && item.time < floor));
    if (!pageToken || (request.newestFirst && reachedKnown)) break;
  }
  if (pageToken && !reachedKnown) {
    logger.warn('[trigger-events/poll] more new items than one check reads; the oldest wait or are missed', {
      externalId: stream.externalId,
      items: items.length,
    });
  }

  const windowOpen = stream.rateWindowStart !== null && now - stream.rateWindowStart.getTime() < HOUR_MS;
  const firesThisHour = windowOpen ? stream.rateWindowFires : 0;
  const plan = planCheck({ items: items.slice(0, MAX_ITEMS_PER_CHECK), seen: stream.seen, primed: stream.primedAt !== null, floor, now, firesThisHour });
  const deliveries = plan.fire.map((item): { key: string; payload: Record<string, unknown> } => {
    const eventId = item.key;
    const delivery: EventDelivery = {
      externalId: stream.externalId,
      eventId,
      type: stream.eventType,
      occurredAt: new Date(item.time ?? now).toISOString(),
      data: boundData(item.data, item.key),
    };
    return { key: `${stream.externalId}:${eventId}`, payload: { provider: MCP_SOURCE_ID, delivery } };
  });
  const patch: StreamPatch = {
    seen: plan.nextSeen,
    primedAt: stream.primedAt ?? new Date(now),
    // A record-first check is done: from here on, items newer than now fire.
    ...(stream.fireAfter.getTime() > now ? { fireAfter: new Date(now) } : {}),
    failures: 0,
    lastError: null,
    lastErrorKind: null,
    lastSuccessAt: new Date(now),
    nextPollAt: new Date(now + (plan.deferred > 0 ? DEFERRED_RECHECK_MS : jittered(stream.intervalSeconds * 1000))),
    rateWindowStart: windowOpen ? stream.rateWindowStart : deliveries.length ? new Date(now) : null,
    rateWindowFires: firesThisHour + deliveries.length,
    intervalSeconds: stream.intervalSeconds,
  };
  // The triggers recover in the same commit as the deliveries: a delivery that ran
  // before an `active` write would find its trigger in `error` and be skipped.
  const recovered = await db.transaction(async (tx) => {
    await enqueueJobs(DELIVER_QUEUE, deliveries, { maxAttempts: DELIVER_MAX_ATTEMPTS, executor: tx });
    if (!(await settleStream(stream, patch, tx))) throw new StaleClaimError();
    return stream.lastError === null ? [] : setRowsStatus(stream.externalId, 'active', null, stream.lastError, tx);
  });

  if (deliveries.length && okRecords[0]) {
    await writeAudit({ ...okRecords[0], resultSummary: { ...(okRecords[0].resultSummary ?? {}), fired: deliveries.length } }).catch(() => null);
  }
  if (plan.dropped > 0) {
    logger.warn('[trigger-events/poll] hourly fire budget spent; items marked seen', {
      externalId: stream.externalId,
      dropped: plan.dropped,
      budget: MAX_FIRES_PER_HOUR,
    });
  }
  for (const row of recovered) {
    await clearTriggerAlert({ projectId: row.projectId, accountId: row.accountId, slug: row.slug, source: 'fire' });
  }
}

let inFlight = 0;

/**
 * Claim due streams into the free slots and start their checks; does not wait
 * for them. Returns how many started.
 */
export async function runDueEventPolls(): Promise<number> {
  const free = CAPACITY - inFlight;
  if (free <= 0) return 0;
  const streams = await claimDueStreams(Math.min(free, CLAIM_LIMIT), LEASE_MS);
  for (const stream of streams) {
    inFlight += 1;
    void runPoll(stream).finally(() => {
      inFlight -= 1;
    });
  }
  return streams.length;
}

registerJobHandler(
  DELIVER_QUEUE,
  async (job) => {
    const { provider, delivery } = job.payload as { provider: string; delivery: EventDelivery };
    const tally = await deliverEvents(provider, [delivery]);
    // The final attempt keeps its failed run and alert, and ends.
    if (tally.failed > 0 && job.attempts < job.maxAttempts) throw new Error(`event ${delivery.eventId}: a trigger fire failed`);
  },
  2 * 60_000,
  4,
);

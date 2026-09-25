/**
 * The lifecycle command queue's drain: claim due rows, release rows that
 * belong to another API instance, and run one lane per session.
 */

import { randomUUID } from 'node:crypto';
import { logger } from '../../lib/logger';
import {
  currentInstanceId,
  sandboxBelongsToThisInstance,
  sandboxInstanceId,
} from '../instance-scope';
import {
  loadSandboxMetadataForSessions,
  loadSessionMetadataForSessions,
  releaseCommandToOwningInstance,
} from './instance-release';
import { runWorkerTick } from '../../shared/audit-scope';
import {
  type SessionLifecycleCommandRow,
  claimDueLifecycleCommands,
  markCommandFailed,
  markCommandSucceeded,
  requeueForAdmission,
} from './store';
import { INBOX_ORDER_BACKOFF_MS } from './inbox-admission';
import { withCommandLeaseHeartbeat } from './command-lease';
import { claimDueSessionInboxSiblings } from './inbox-rows';
import { compareInboxSendOrder } from './inbox-order';
import { groupEndedResponse, groupRemintsTogether, quickQueueGroup } from './quick-queue-group';
import type { QueuedCreateSessionPayload } from './types';
import { type QueuedContinueOptions, executeQueuedContinue } from './queued-continue';
import {
  applyPostCreateActions,
  executeQueuedCreate,
  isRetryableCreateError,
} from './create-session';

/** How far out a released foreign command is re-queued; the owner's drain ticks every 1s. */
const INSTANCE_RELEASE_DELAY_MS = 2_000;

/**
 * Drain queued lifecycle commands as the `session-lifecycle` worker. Request
 * handlers kick this for their own command, but a drain also runs commands
 * other principals queued; each command row names its own actor.
 */
export function drainSessionLifecycleQueue(
  input: Parameters<typeof drainSessionLifecycleQueueTick>[0] = {},
): ReturnType<typeof drainSessionLifecycleQueueTick> {
  return runWorkerTick('session-lifecycle', () => drainSessionLifecycleQueueTick(input));
}

async function drainSessionLifecycleQueueTick(
  input: {
    workerId?: string;
    limit?: number;
    /** Drain one freshly-enqueued callback without waiting behind older work. */
    idempotencyKey?: string;
    /** Completion wakes target rows already in the inbox; they need no burst delay. */
    coalesce?: boolean;
    /** Only drain commands due before this instant — see claimDueLifecycleCommands. */
    availableBefore?: Date;
  } = {},
): Promise<{ claimed: number; succeeded: number; failed: number; queued: number; released: number }> {
  // Unique per drain: the lock owner is every claimed row's fencing token.
  const workerId = input.workerId ?? `session-lifecycle:${process.pid}:${randomUUID()}`;
  // COALESCE a burst before claiming. A targeted kick fires per POST, and the
  // composer sends a burst's POSTs concurrently — their arrival order is the
  // network's. Claiming instantly let the first arrival's batch close before
  // the rest of the burst was even durable (measured: one of four boot sends
  // delivered a step behind, out of order). A quarter second collects the
  // stragglers and is invisible next to the ~1.3 s delivery itself.
  if (input.idempotencyKey && input.coalesce !== false) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const rows = await claimDueLifecycleCommands({
    workerId,
    limit: input.limit ?? 10,
    idempotencyKey: input.idempotencyKey,
    availableBefore: input.availableBefore,
  });
  // A DRAIN THAT HOLDS ONE OF A SESSION'S INBOX ROWS HOLDS ALL OF THEM.
  //
  // A targeted claim (one POST's kick) takes exactly its own row — but the
  // rows already queued for the SAME session are this delivery's batch, and
  // leaving them to their own kicks is what delivered a burst of sends one
  // ~1.5 s round-trip at a time (and let a step boundary split the answers).
  //
  // The SCHEDULER claim (`worker.ts`, every 1 s) takes only rows that are DUE,
  // and after an interrupt a burst's rows sit on three different clocks: the
  // head on the admission gate's compounding backoff, each released sibling on
  // a flat 300 ms from whenever its own drain reached it. Measured 2026-09-22,
  // 2 of 2 runs: `available_at` 47.730 / 49.224 / 47.496 s, the tick claimed
  // rows 1 and 3, and the grouping rule merged them ACROSS row 2 — which then
  // went out ~3 s later, out of send order, with one prompt never answered. So
  // the sweep runs on EVERY claim path, not only the targeted one, and the
  // batch is the session's whole queued inbox rather than the due part of it.
  const sweepGaps = new Map<string, SessionLifecycleCommandRow | null>();
  if (rows.length > 0) {
    const sessions = [...new Set(rows.map((r) => r.sessionId).filter((v): v is string => !!v))];
    for (const sessionId of sessions) {
      const sweep = await claimDueSessionInboxSiblings({ workerId, sessionId });
      rows.push(
        ...sweep.claimed.filter((sib) => !rows.some((r) => r.commandId === sib.commandId)),
      );
      // A row another worker won the CAS on is still a HOLE in this batch, and
      // a group may not span it — see `quickQueueGroup`'s `firstUnclaimed`.
      sweepGaps.set(sessionId, sweep.firstUnclaimed);
    }
  }
  const out = { claimed: rows.length, succeeded: 0, failed: 0, queued: 0, released: 0 };

  // INSTANCE SCOPE (local dev on a shared DB — projects/instance-scope.ts).
  // A command whose session's sandbox was provisioned by ANOTHER API instance
  // goes back on the queue for that instance: executing it here would push
  // this instance's `KORTIX_URL` (its tunnel) into a box that is not ours.
  // Gated on `KORTIX_INSTANCE_ID`, so deployed environments never run the
  // lookup. Done here, after the claim and the sibling sweep, so every
  // command type and every claim path is covered.
  const mine = currentInstanceId();
  if (mine && rows.length > 0) {
    const sessionIds = [...new Set(rows.map((r) => r.sessionId).filter((v): v is string => !!v))];
    const metadataBySession =
      sessionIds.length > 0 ? await loadSandboxMetadataForSessions(sessionIds) : new Map();
    // NO SANDBOX ROW YET: the session row is the owner. A first prompt is
    // inserted with its session, seconds before the box row exists, and the
    // instance that claimed it in that window pushed ITS gateway URL into the
    // box (2026-09-22: the value flapped and the daemon disposed OpenCode
    // mid-turn). An unstamped session row still belongs to everyone.
    const boxless = sessionIds.filter((id) => !metadataBySession.has(id));
    if (boxless.length > 0) {
      const sessionMetadata = await loadSessionMetadataForSessions(boxless);
      for (const [id, metadata] of sessionMetadata) metadataBySession.set(id, metadata);
    }
    const availableAt = new Date(Date.now() + INSTANCE_RELEASE_DELAY_MS);
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i];
      if (!row.sessionId) continue;
      const metadata = metadataBySession.get(row.sessionId);
      if (metadata === undefined || sandboxBelongsToThisInstance(metadata)) continue;
      const owner = sandboxInstanceId(metadata);
      await releaseCommandToOwningInstance(row, { availableAt, owner }).catch((err) => {
        logger.warn('[session-lifecycle] instance-scope release failed; lock expiry will reclaim', {
          commandId: row.commandId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      logger.info('[session-lifecycle] command belongs to another instance — released', {
        commandId: row.commandId,
        sessionId: row.sessionId,
        commandType: row.commandType,
        owner,
        instance: mine,
      });
      rows.splice(i, 1);
      out.released += 1;
    }
  }

  // ONE LANE PER SESSION, and the lanes run concurrently.
  //
  // Order matters WITHIN a session and nowhere else, so that is the only order
  // kept. Draining the whole claim sequentially made every prompt in the batch
  // wait behind the slowest one, and the slowest one can be very slow:
  // `continueSession` waits up to `READY_DEADLINE_MS` (5 min) for a cold box.
  // With every user prompt in the product now going through this queue, one
  // cold boot would hold nine other people's messages for the length of it.
  const lanes = new Map<string, SessionLifecycleCommandRow[]>();
  for (const row of rows) {
    // A create has no session yet; each one is its own lane.
    const lane = row.sessionId ?? `command:${row.commandId}`;
    const existing = lanes.get(lane);
    if (existing) existing.push(row);
    else lanes.set(lane, [row]);
  }

  // Every claimed row runs under its lease: the lock is renewed while the row
  // is in hand, and every write that ends the claim names the lease.
  const runRow = (
    row: SessionLifecycleCommandRow,
    options?: QueuedContinueOptions,
  ): Promise<'succeeded' | 'queued' | 'failed' | null> =>
    withCommandLeaseHeartbeat(row, () => runClaimedRow(row, options));

  async function runClaimedRow(
    row: SessionLifecycleCommandRow,
    options?: QueuedContinueOptions,
  ): Promise<'succeeded' | 'queued' | 'failed' | null> {
    if (row.commandType === 'continue_session') {
      // Contained per row. Every row in this batch is CLAIMED (`running`), and
      // one throw escaping the loop would leave the rest of them there — a
      // state nothing reclaims until the lock expires, and one that blocks
      // every later prompt of the same session behind it.
      const outcome = await executeQueuedContinue(row, options).catch(async (err) => {
        await markCommandFailed(
          row,
          `drain failed: ${err instanceof Error ? err.message : String(err)}`,
          { retryable: true, attempts: row.attempts, sessionId: row.sessionId },
        ).catch(() => undefined);
        return 'failed' as const;
      });
      out[outcome] += 1;
      return outcome;
    }
    if (row.commandType !== 'create_session') {
      await markCommandFailed(row, `Unsupported command type: ${row.commandType}`, {
        retryable: false,
        attempts: row.attempts,
      });
      out.failed += 1;
      return null;
    }
    const result = await executeQueuedCreate(row);
    if (result.status === 'created' && result.sessionId) {
      const payload = row.payload as unknown as QueuedCreateSessionPayload;
      const postCreate = await applyPostCreateActions({
        projectId: row.projectId,
        sessionId: result.sessionId,
        actions: payload.postCreate,
        commandId: row.commandId,
      });
      if (!postCreate.ok) {
        await markCommandFailed(row, postCreate.error, {
          retryable: true,
          attempts: row.attempts,
          sessionId: result.sessionId,
          result: {
            status: 'created',
            session_id: result.sessionId,
            source: row.source,
            post_create_error: postCreate.error,
          },
        });
        out.queued += 1;
        return null;
      }
      await markCommandSucceeded(
        row,
        { status: 'created', session_id: result.sessionId, source: row.source },
        result.sessionId,
      );
      out.succeeded += 1;
    } else {
      const message = String(
        result.error?.body?.error ?? result.reason ?? 'Failed to create queued session',
      );
      const retryable = result.retryable ?? isRetryableCreateError(result.error?.status);
      await markCommandFailed(row, message, { retryable, attempts: row.attempts });
      if (retryable) out.queued += 1;
      else out.failed += 1;
    }
    return null;
  }

  /** Put a claimed row this drain is not going to send back in line. */
  const releaseSibling = async (row: SessionLifecycleCommandRow): Promise<void> => {
    await requeueForAdmission(
      row,
      'older_prompt_pending',
      new Date(Date.now() + INBOX_ORDER_BACKOFF_MS),
    );
    out.queued += 1;
  };

  /** Renew every group row's lease while the group is in hand: the tail waits
   *  claimed behind the head's delivery, which can outlast one lock period. */
  const withGroupLeaseHeartbeat = <T>(
    group: readonly SessionLifecycleCommandRow[],
    work: () => Promise<T>,
  ): Promise<T> =>
    group.reduceRight<() => Promise<T>>(
      (inner, groupRow) => () => withCommandLeaseHeartbeat(groupRow, inner),
      work,
    )();

  await Promise.all(
    [...lanes.values()].map(async (lane) => {
      // ONE GROUPED ANSWER PER DRAIN, not one message.
      //
      // WAS: one inbox row per session reached OpenCode per drain, because
      // plain `/prompt_async` starts a reply for every message it takes — so
      // two rows posted back to back produced two replies racing one
      // transcript, and "both rows reported delivered while the first answer
      // rendered under the second prompt".
      //
      // A GROUP is sent together (`quick-queue-group.ts`): rows 1..N-1 with
      // `noReply: true` (persisted, no reply started) and row N normally.
      // Exactly one reply exists, so the failure above has no mechanism. A
      // group is one placement: the Quick Queue (the owner's rule of
      // 2026-09-21) or the Queue List (2026-09-24, "sent all at once, not one
      // by one"). An unplaced row and a held row still go one per drain, and
      // the rows this drain does not take are returned to the queue in order.
      let i = 0;
      while (i < lane.length) {
        const row = lane[i];
        if (!isInboxRow(row)) {
          await runRow(row);
          i += 1;
          continue;
        }
        let j = i + 1;
        while (j < lane.length && isInboxRow(lane[j])) j += 1;
        const batch = lane.slice(i, j).sort(compareInboxSendOrder);
        i = j;
        // A GROUP IS A CONTIGUOUS FIFO RUN. The sweep above says where this
        // drain's hold on the session's inbox stops; the run stops there too.
        const group = quickQueueGroup(batch, {
          firstUnclaimed: row.sessionId ? (sweepGaps.get(row.sessionId) ?? null) : null,
        });
        // Claims mark every sibling `running`. Release everything outside the
        // group before the head reaches admission — `hasInFlightPrompt` reads
        // a claimed row as another delivery already on the wire. The group's
        // own rows stay claimed and are handed to admission as exempt.
        for (const sibling of batch.slice(group.length)) await releaseSibling(sibling);
        const endedResponse = groupEndedResponse(group);
        if (group.length < 2) {
          await runRow(batch[0], endedResponse ? { endedResponse } : undefined);
          continue;
        }
        const groupIds = group.map((entry) => entry.commandId);
        // A GROUP MINTS AS ONE. One row of it that waited is lifted above the
        // transcript; a fresh row beside it would keep a client id that sorts
        // BELOW that lift, and the tab would draw the group out of order.
        const remintWithGroup = groupRemintsTogether(group);
        await withGroupLeaseHeartbeat(group, async () => {
          for (let n = 0; n < group.length; n += 1) {
            const last = n === group.length - 1;
            const outcome = await runRow(group[n], {
              remintWithGroup,
              // Only the HEAD is gated. The rest of the group is this delivery's
              // own, already-claimed tail: re-running admission for it would read
              // its own siblings as in-flight, and the turn state it decided on
              // has not changed since. Stop is still re-read before every POST
              // (`assertInboxDeliveryActive`).
              admitted: n > 0,
              groupCommandIds: n === 0 ? groupIds.slice(1) : undefined,
              noReply: !last,
              groupedMessageCount: last ? group.length : undefined,
              // Only the row that OPENS the reply can carry a note to the model.
              endedResponse: last && endedResponse ? true : undefined,
            });
            if (outcome === 'succeeded') continue;
            // ORDER MUST HOLD. Row N is never posted normally after an earlier
            // row of its group failed — that would open a reply for a group the
            // user never sent. The rows already persisted stay persisted; the
            // next group's final post starts the one reply that reads them all.
            for (const pending of group.slice(n + 1)) await releaseSibling(pending);
            break;
          }
        });
      }
    }),
  );
  return out;
}

/** An inbox prompt row: a `continue_session` with the client's own
 *  submission id — what the queue strip lists and what batches. */
function isInboxRow(row: SessionLifecycleCommandRow): boolean {
  if (row.commandType !== 'continue_session') return false;
  const payload = row.payload as { clientMessageId?: unknown } | null;
  return typeof payload?.clientMessageId === 'string' && payload.clientMessageId.length > 0;
}

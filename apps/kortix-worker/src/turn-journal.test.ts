import { describe, expect, test } from 'bun:test';
import { isDeepStrictEqual } from 'node:util';

import {
  type SessionLog,
  SessionLogConflictError,
  type SessionLogItem,
  type StorageLogItem,
} from './session-store.ts';
import {
  TURN_JOURNAL_STREAM,
  type TurnAdmission,
  TurnAdmissionJournal,
  TurnJournalCorruptionError,
  type WireMessageEnvelope,
  reduceTurnJournal,
} from './turn-journal.ts';

class MemoryLog implements SessionLog {
  readonly items: SessionLogItem[];

  constructor(items: SessionLogItem[] = []) {
    this.items = [...items];
  }

  async append(item: SessionLogItem): Promise<void> {
    this.items.push(structuredClone(item));
  }

  async read(): Promise<SessionLogItem[]> {
    return structuredClone(this.items);
  }
}

class FencedMemoryLog extends MemoryLog {
  private readonly byKey = new Map<string, SessionLogItem>();

  override async append(
    item: SessionLogItem,
    options: { idempotencyKey?: string } = {},
  ): Promise<void> {
    const key = options.idempotencyKey;
    if (!key) return super.append(item);
    const existing = this.byKey.get(key);
    if (existing) {
      if (isDeepStrictEqual(existing, item)) return;
      throw new SessionLogConflictError('fence already claimed');
    }
    const clone = structuredClone(item);
    this.byKey.set(key, clone);
    this.items.push(clone);
  }
}

function wireMessage(
  id: string,
  role: 'user' | 'assistant',
  text: string,
  parentID?: string,
): WireMessageEnvelope {
  return {
    info: {
      id,
      role,
      sessionID: 'ses_pi1',
      ...(parentID ? { parentID } : {}),
    },
    parts: [
      {
        id: `${id}-p0`,
        messageID: id,
        sessionID: 'ses_pi1',
        type: 'text',
        text,
      },
    ],
  };
}

function turn(messageId: string, text = messageId): TurnAdmission {
  return {
    messageId,
    text,
    options: { agent: 'build', model: { providerID: 'kortix', modelID: 'sonnet' } },
    wireUserMessage: wireMessage(messageId, 'user', text),
  };
}

function deferredGate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function requireValue<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`${label} is required`);
  return value;
}

function accepted(value: TurnAdmission): SessionLogItem {
  return {
    kind: 'journal',
    stream: TURN_JOURNAL_STREAM,
    record: { type: 'accepted', turn: value },
  };
}

function cancelled(messageId: string): SessionLogItem {
  return {
    kind: 'journal',
    stream: TURN_JOURNAL_STREAM,
    record: { type: 'cancelled', messageId },
  };
}

function started(messageId: string): SessionLogItem {
  return {
    kind: 'journal',
    stream: TURN_JOURNAL_STREAM,
    record: { type: 'started', messageId },
  };
}

function completed(
  messageId: string,
  assistantWireMessages: WireMessageEnvelope[],
): SessionLogItem {
  return {
    kind: 'journal',
    stream: TURN_JOURNAL_STREAM,
    record: { type: 'completed', messageId, assistantWireMessages },
  };
}

describe('TurnAdmissionJournal', () => {
  test('does not expose an acceptance until its append commits', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const log = new MemoryLog();
    log.append = async (item) => {
      await gate;
      log.items.push(structuredClone(item));
    };
    const journal = await TurnAdmissionJournal.open(log);

    const append = journal.accept(turn('msg_01', 'hello'));
    await Promise.resolve();
    expect(journal.pending).toEqual([]);
    expect(log.items).toEqual([]);

    release();
    expect(await append).toBe(true);
    expect(journal.pending).toEqual([turn('msg_01', 'hello')]);
  });

  test('reduces pending turns in acceptance order and preserves exact wire ids across restart', async () => {
    const first = turn('msg_01', 'first');
    const second = turn('msg_02', 'second');
    const third = turn('msg_03', 'third');
    const reply = wireMessage('msg_04', 'assistant', 'done', first.messageId);
    const log = new MemoryLog([
      { kind: 'name', name: 'unrelated storage item' },
      accepted(first),
      accepted(second),
      completed(first.messageId, [reply]),
      cancelled(second.messageId),
      cancelled(second.messageId),
      accepted(third),
      accepted(third),
      completed(first.messageId, [reply]),
    ]);

    const journal = await TurnAdmissionJournal.open(log);

    expect(journal.pending).toEqual([third]);
    expect(journal.wireMessages).toEqual([first.wireUserMessage, reply, third.wireUserMessage]);
    expect(journal.state(first.messageId)).toBe('completed');
    expect(journal.state(second.messageId)).toBe('cancelled');
    expect(journal.state(third.messageId)).toBe('pending');
  });

  test('does not append duplicate accept, complete, or terminal transitions', async () => {
    const log = new MemoryLog();
    const journal = await TurnAdmissionJournal.open(log);
    const admission = turn('msg_01');
    const reply = wireMessage('msg_02', 'assistant', 'done', admission.messageId);

    expect(await journal.accept(admission)).toBe(true);
    expect(await journal.accept(structuredClone(admission))).toBe(false);
    expect(await journal.complete(admission.messageId, [reply])).toBe(true);
    expect(await journal.complete(admission.messageId, [structuredClone(reply)])).toBe(true);
    expect(await journal.cancel(admission.messageId)).toBe(false);

    expect(
      log.items.map((item) => (item.kind === 'journal' ? (item.record.type as string) : item.kind)),
    ).toEqual(['accepted', 'completed']);
    expect(journal.wireMessages).toEqual([
      admission.wireUserMessage,
      { info: reply.info, parts: [] },
    ]);
  });

  test('persists assistant metadata in bounded items and never duplicates large message parts', async () => {
    const log = new MemoryLog();
    const journal = await TurnAdmissionJournal.open(log);
    const admission = turn('msg_01');
    const first = wireMessage('msg_02', 'assistant', 'x'.repeat(300 * 1024), admission.messageId);
    const second = wireMessage('msg_03', 'assistant', 'y'.repeat(300 * 1024), admission.messageId);

    await journal.accept(admission);
    await journal.start(admission.messageId);
    expect(await journal.complete(admission.messageId, [first, second])).toBe(true);

    const completionItems = log.items.slice(2);
    expect(
      completionItems.map((item) =>
        item.kind === 'journal' ? (item.record.type as string) : item.kind,
      ),
    ).toEqual(['completed']);
    expect(completionItems.every((item) => JSON.stringify(item).length < 10_000)).toBe(true);
    expect(journal.wireMessages).toEqual([
      admission.wireUserMessage,
      { info: first.info, parts: [] },
      { info: second.info, parts: [] },
    ]);
  });

  test('durably tracks completed turns until their exact relay succeeds', async () => {
    const log = new MemoryLog();
    const journal = await TurnAdmissionJournal.open(log);
    const admission = turn('msg_01');

    await journal.accept(admission);
    await journal.start(admission.messageId);
    await journal.complete(admission.messageId, [], 'error');
    expect(journal.unrelayed).toEqual([{ messageId: admission.messageId, status: 'error' }]);
    expect(await journal.markRelayed(admission.messageId)).toBe(true);
    expect(await journal.markRelayed(admission.messageId)).toBe(false);

    const reopened = await TurnAdmissionJournal.open(log);
    expect(reopened.unrelayed).toEqual([]);
  });

  test('two worker journals share one model-start fence', async () => {
    const log = new FencedMemoryLog();
    const [first, second] = await Promise.all([
      TurnAdmissionJournal.open(log),
      TurnAdmissionJournal.open(log),
    ]);
    const admission = turn('msg_01', 'same input');

    expect(await Promise.all([first.accept(admission), second.accept(admission)])).toEqual([
      true,
      true,
    ]);
    const starts = await Promise.all([
      first.start(admission.messageId),
      second.start(admission.messageId),
    ]);

    expect(starts.filter(Boolean)).toHaveLength(1);
    expect(
      log.items.filter((item) => item.kind === 'journal' && item.record.type === 'started'),
    ).toHaveLength(1);
  });

  test('heartbeats renew one owner lease and recovery fences out the stale owner', async () => {
    const log = new FencedMemoryLog();
    const owner = await TurnAdmissionJournal.open(log);
    const admission = turn('msg_lease', 'owned input');
    await owner.accept(admission);
    expect(await owner.start(admission.messageId)).toBe(true);
    const initial = requireValue(owner.startedLease(admission.messageId), 'initial lease');
    expect(initial.ownerId).toEqual(expect.any(String));
    expect(initial.revision).toBe(1);

    const replacement = await TurnAdmissionJournal.open(log);
    expect(await owner.heartbeat(admission.messageId)).toBe(true);
    await replacement.refresh();
    const renewed = requireValue(replacement.startedLease(admission.messageId), 'renewed lease');
    expect(renewed.ownerId).toBe(initial.ownerId);
    expect(renewed.revision).toBe(2);
    expect(await replacement.reclaim(admission.messageId, initial)).toBe(false);
    expect(await replacement.reclaim(admission.messageId, renewed)).toBe(true);

    expect(await owner.complete(admission.messageId)).toBe(false);
    expect(await owner.heartbeat(admission.messageId)).toBe(false);
    expect(await replacement.complete(admission.messageId)).toBe(true);
    expect(replacement.state(admission.messageId)).toBe('completed');
  });

  test('transcript append and reclaim contend on one lease CAS in either append order', async () => {
    for (const winner of ['transcript', 'reclaimed'] as const) {
      const transcriptGate = deferredGate();
      const reclaimGate = deferredGate();
      const transcriptReached = deferredGate();
      const reclaimReached = deferredGate();
      let transcriptKey: string | undefined;
      let reclaimKey: string | undefined;
      class RacingLog extends FencedMemoryLog {
        override async append(
          item: SessionLogItem,
          options: { idempotencyKey?: string } = {},
        ): Promise<void> {
          if (item.kind === 'entry' && item._kortixTurnLease && !transcriptKey) {
            transcriptKey = options.idempotencyKey;
            transcriptReached.release();
            await transcriptGate.promise;
          }
          if (item.kind === 'journal' && item.record.type === 'reclaimed' && !reclaimKey) {
            reclaimKey = options.idempotencyKey;
            reclaimReached.release();
            await reclaimGate.promise;
          }
          return super.append(item, options);
        }
      }

      const log = new RacingLog();
      const owner = await TurnAdmissionJournal.open(log);
      const admission = turn(`msg_transcript_race_${winner}`);
      await owner.accept(admission);
      await owner.start(admission.messageId);
      const replacement = await TurnAdmissionJournal.open(log);
      const observed = replacement.startedLease(admission.messageId);
      if (!observed) throw new Error('replacement did not observe the started lease');
      const entry: StorageLogItem = {
        kind: 'entry',
        lane: 'main',
        entry: {
          id: `entry_${winner}`,
          type: 'message',
          message: { role: 'assistant', content: [{ type: 'text', text: 'durable' }] },
        },
      };
      const transcript = owner.appendTranscriptMutation(admission.messageId, entry);
      const reclaim = replacement.reclaim(admission.messageId, observed);
      await Promise.all([transcriptReached.promise, reclaimReached.promise]);
      expect(transcriptKey).toBe(reclaimKey);

      if (winner === 'transcript') {
        transcriptGate.release();
        expect(await transcript).toBe(true);
        reclaimGate.release();
        expect(await reclaim).toBe(false);
      } else {
        reclaimGate.release();
        expect(await reclaim).toBe(true);
        transcriptGate.release();
        expect(await transcript).toBe(false);
      }

      const reopened = await TurnAdmissionJournal.open(log);
      expect(reopened.startedLease(admission.messageId)?.revision).toBe(2);
      expect(log.items.filter((item) => item.kind === 'entry')).toHaveLength(
        winner === 'transcript' ? 1 : 0,
      );
    }
  });

  test('persists an idempotent cross-worker abort request for the active owner', async () => {
    const log = new FencedMemoryLog();
    const owner = await TurnAdmissionJournal.open(log);
    const admission = turn('msg_abort', 'stop this turn');
    await owner.accept(admission);
    await owner.start(admission.messageId);
    const remote = await TurnAdmissionJournal.open(log);

    expect(await remote.requestAbort(admission.messageId)).toBe(true);
    expect(await remote.requestAbort(admission.messageId)).toBe(true);
    await owner.refresh();
    expect(owner.abortRequested(admission.messageId)).toBe(true);
    expect(await owner.acknowledgeAbort(admission.messageId)).toBe(true);
    await remote.refresh();
    expect(remote.abortAcknowledged(admission.messageId)).toBe(true);
    expect(
      log.items.filter((item) => item.kind === 'journal' && item.record.type === 'abort_requested'),
    ).toHaveLength(1);
  });

  test('outage recovery only interrupts the lease that this worker still owns', async () => {
    const log = new FencedMemoryLog();
    const owner = await TurnAdmissionJournal.open(log);
    const admission = turn('msg_outage_owner', 'owned input');
    await owner.accept(admission);
    await owner.start(admission.messageId);
    const replacement = await TurnAdmissionJournal.open(log);
    expect(await replacement.requestAbort(admission.messageId, { ownLeaseOnly: true })).toBe(false);
    expect(await owner.requestAbort(admission.messageId, { ownLeaseOnly: true })).toBe(true);
    await replacement.refresh();
    const lease = requireValue(replacement.startedLease(admission.messageId), 'current lease');
    expect(await replacement.reclaim(admission.messageId, lease)).toBe(true);
    expect(await owner.requestAbort(admission.messageId, { ownLeaseOnly: true })).toBe(false);
  });

  test('heartbeat and reclaim contend on one lease CAS in either append order', async () => {
    for (const winner of ['heartbeat', 'reclaimed'] as const) {
      let releaseHeartbeat!: () => void;
      let releaseReclaim!: () => void;
      let reachedHeartbeat!: () => void;
      let reachedReclaim!: () => void;
      const heartbeatGate = new Promise<void>((resolve) => {
        releaseHeartbeat = resolve;
      });
      const reclaimGate = new Promise<void>((resolve) => {
        releaseReclaim = resolve;
      });
      const heartbeatReached = new Promise<void>((resolve) => {
        reachedHeartbeat = resolve;
      });
      const reclaimReached = new Promise<void>((resolve) => {
        reachedReclaim = resolve;
      });
      class RacingLog extends FencedMemoryLog {
        override async append(
          item: SessionLogItem,
          options: { idempotencyKey?: string } = {},
        ): Promise<void> {
          const type = item.kind === 'journal' ? item.record.type : null;
          if (type === 'heartbeat') {
            reachedHeartbeat();
            await heartbeatGate;
          }
          if (type === 'reclaimed') {
            reachedReclaim();
            await reclaimGate;
          }
          return super.append(item, options);
        }
      }

      const log = new RacingLog();
      const owner = await TurnAdmissionJournal.open(log);
      const admission = turn(`msg_race_${winner}`);
      await owner.accept(admission);
      await owner.start(admission.messageId);
      const replacement = await TurnAdmissionJournal.open(log);
      const observed = requireValue(
        replacement.startedLease(admission.messageId),
        'observed lease',
      );
      const heartbeat = owner.heartbeat(admission.messageId);
      const reclaim = replacement.reclaim(admission.messageId, observed);
      await Promise.all([heartbeatReached, reclaimReached]);

      if (winner === 'heartbeat') {
        releaseHeartbeat();
        expect(await heartbeat).toBe(true);
        releaseReclaim();
        expect(await reclaim).toBe(false);
      } else {
        releaseReclaim();
        expect(await reclaim).toBe(true);
        releaseHeartbeat();
        expect(await heartbeat).toBe(false);
      }

      const reopened = await TurnAdmissionJournal.open(log);
      expect(reopened.state(admission.messageId)).toBe('started');
      expect(reopened.startedLease(admission.messageId)?.revision).toBe(2);
    }
  });

  test('heartbeat and abort request preserve the same owner in either append order', async () => {
    for (const winner of ['heartbeat', 'abort_requested'] as const) {
      const heartbeatGate = deferredGate();
      const abortGate = deferredGate();
      const heartbeatReached = deferredGate();
      const abortReached = deferredGate();
      let heartbeatKey: string | undefined;
      let abortKey: string | undefined;
      class RacingLog extends FencedMemoryLog {
        override async append(
          item: SessionLogItem,
          options: { idempotencyKey?: string } = {},
        ): Promise<void> {
          const type = item.kind === 'journal' ? item.record.type : null;
          if (type === 'heartbeat' && !heartbeatKey) {
            heartbeatKey = options.idempotencyKey;
            heartbeatReached.release();
            await heartbeatGate.promise;
          }
          if (type === 'abort_requested' && !abortKey) {
            abortKey = options.idempotencyKey;
            abortReached.release();
            await abortGate.promise;
          }
          return super.append(item, options);
        }
      }

      const log = new RacingLog();
      const owner = await TurnAdmissionJournal.open(log);
      const admission = turn(`msg_abort_heartbeat_${winner}`);
      await owner.accept(admission);
      await owner.start(admission.messageId);
      const remote = await TurnAdmissionJournal.open(log);
      const heartbeat = owner.heartbeat(admission.messageId);
      const abort = remote.requestAbort(admission.messageId);
      await Promise.all([heartbeatReached.promise, abortReached.promise]);
      expect(heartbeatKey).toBe(abortKey);

      if (winner === 'heartbeat') {
        heartbeatGate.release();
        expect(await heartbeat).toBe(true);
        abortGate.release();
        expect(await abort).toBe(true);
      } else {
        abortGate.release();
        expect(await abort).toBe(true);
        heartbeatGate.release();
        expect(await heartbeat).toBe(true);
      }

      const reopened = await TurnAdmissionJournal.open(log);
      expect(reopened.state(admission.messageId)).toBe('started');
      expect(reopened.abortRequested(admission.messageId)).toBe(true);
    }
  });

  test('completion and reclaim contend on one lease CAS in either append order', async () => {
    for (const winner of ['completed', 'reclaimed'] as const) {
      let releaseCompletion!: () => void;
      let releaseReclaim!: () => void;
      let reachedCompletion!: () => void;
      let reachedReclaim!: () => void;
      const completionGate = new Promise<void>((resolve) => {
        releaseCompletion = resolve;
      });
      const reclaimGate = new Promise<void>((resolve) => {
        releaseReclaim = resolve;
      });
      const completionReached = new Promise<void>((resolve) => {
        reachedCompletion = resolve;
      });
      const reclaimReached = new Promise<void>((resolve) => {
        reachedReclaim = resolve;
      });
      let completionKey: string | undefined;
      let reclaimKey: string | undefined;
      class RacingLog extends FencedMemoryLog {
        override async append(
          item: SessionLogItem,
          options: { idempotencyKey?: string } = {},
        ): Promise<void> {
          const type = item.kind === 'journal' ? item.record.type : null;
          if (type === 'completed') {
            completionKey = options.idempotencyKey;
            reachedCompletion();
            await completionGate;
          }
          if (type === 'reclaimed') {
            reclaimKey = options.idempotencyKey;
            reachedReclaim();
            await reclaimGate;
          }
          return super.append(item, options);
        }
      }

      const log = new RacingLog();
      const owner = await TurnAdmissionJournal.open(log);
      const admission = turn(`msg_completion_race_${winner}`);
      await owner.accept(admission);
      await owner.start(admission.messageId);
      const replacement = await TurnAdmissionJournal.open(log);
      const observed = requireValue(
        replacement.startedLease(admission.messageId),
        'observed lease',
      );
      const completion = owner.complete(admission.messageId, [
        wireMessage(`${admission.messageId}_reply`, 'assistant', 'done', admission.messageId),
      ]);
      const reclaim = replacement.reclaim(admission.messageId, observed);
      await Promise.all([completionReached, reclaimReached]);
      expect(completionKey).toBe(reclaimKey);

      if (winner === 'completed') {
        releaseCompletion();
        expect(await completion).toBe(true);
        releaseReclaim();
        expect(await reclaim).toBe(false);
      } else {
        releaseReclaim();
        expect(await reclaim).toBe(true);
        releaseCompletion();
        expect(await completion).toBe(false);
      }

      const reopened = await TurnAdmissionJournal.open(log);
      expect(reopened.state(admission.messageId)).toBe(
        winner === 'completed' ? 'completed' : 'started',
      );
      expect(
        log.items.filter(
          (item) =>
            item.kind === 'journal' &&
            (item.record.type === 'completed' || item.record.type === 'reclaimed'),
        ),
      ).toHaveLength(1);
      if (winner === 'completed') {
        expect(reopened.wireMessages).toHaveLength(2);
      } else {
        expect(reopened.wireMessages).toEqual([admission.wireUserMessage]);
        expect(
          await replacement.complete(admission.messageId, [
            wireMessage(`${admission.messageId}_reply`, 'assistant', 'done', admission.messageId),
          ]),
        ).toBe(true);
        const completedByReplacement = await TurnAdmissionJournal.open(log);
        expect(completedByReplacement.wireMessages).toHaveLength(2);
      }
    }
  });

  test('completion and abort request contend on one lease CAS in either append order', async () => {
    for (const winner of ['completed', 'abort_requested'] as const) {
      const completionGate = deferredGate();
      const abortGate = deferredGate();
      const completionReached = deferredGate();
      const abortReached = deferredGate();
      let completionKey: string | undefined;
      let abortKey: string | undefined;
      class RacingLog extends FencedMemoryLog {
        override async append(
          item: SessionLogItem,
          options: { idempotencyKey?: string } = {},
        ): Promise<void> {
          const type = item.kind === 'journal' ? item.record.type : null;
          if (type === 'completed' && !completionKey) {
            completionKey = options.idempotencyKey;
            completionReached.release();
            await completionGate.promise;
          }
          if (type === 'abort_requested' && !abortKey) {
            abortKey = options.idempotencyKey;
            abortReached.release();
            await abortGate.promise;
          }
          return super.append(item, options);
        }
      }

      const log = new RacingLog();
      const owner = await TurnAdmissionJournal.open(log);
      const admission = turn(`msg_abort_completion_${winner}`);
      const reply = wireMessage(
        `${admission.messageId}_reply`,
        'assistant',
        'done',
        admission.messageId,
      );
      await owner.accept(admission);
      await owner.start(admission.messageId);
      const remote = await TurnAdmissionJournal.open(log);
      const completion = owner.complete(admission.messageId, [reply]);
      const abort = remote.requestAbort(admission.messageId);
      await Promise.all([completionReached.promise, abortReached.promise]);
      expect(completionKey).toBe(abortKey);

      if (winner === 'completed') {
        completionGate.release();
        expect(await completion).toBe(true);
        abortGate.release();
        expect(await abort).toBe(false);
      } else {
        abortGate.release();
        expect(await abort).toBe(true);
        completionGate.release();
        expect(await completion).toBe(false);
        expect(await owner.acknowledgeAbort(admission.messageId)).toBe(true);
        expect(await owner.complete(admission.messageId, [reply], 'error')).toBe(true);
      }

      const reopened = await TurnAdmissionJournal.open(log);
      expect(reopened.state(admission.messageId)).toBe('completed');
      expect(reopened.unrelayed).toEqual([
        {
          messageId: admission.messageId,
          status: winner === 'completed' ? 'idle' : 'error',
        },
      ]);
    }
  });

  test('only the oldest durable non-terminal turn can cross the model boundary', async () => {
    const log = new FencedMemoryLog();
    const [first, second] = await Promise.all([
      TurnAdmissionJournal.open(log),
      TurnAdmissionJournal.open(log),
    ]);
    const older = turn('msg_01', 'older');
    const newer = turn('msg_02', 'newer');

    await first.accept(older);
    await second.accept(newer);

    expect(await second.start(newer.messageId)).toBe(false);
    expect(second.state(newer.messageId)).toBe('pending');
    expect(await first.start(older.messageId)).toBe(true);
    await first.complete(older.messageId);
    expect(await second.start(newer.messageId)).toBe(true);
  });

  test('a stale transition loser accepts a winner that already completed', async () => {
    const admission = turn('msg_01', 'same input');
    const log = new FencedMemoryLog([accepted(admission)]);
    const [winner, staleStarter, staleCanceller] = await Promise.all([
      TurnAdmissionJournal.open(log),
      TurnAdmissionJournal.open(log),
      TurnAdmissionJournal.open(log),
    ]);

    expect(await winner.start(admission.messageId)).toBe(true);
    expect(await winner.complete(admission.messageId)).toBe(true);
    expect(await staleStarter.start(admission.messageId)).toBe(false);
    expect(await staleCanceller.cancel(admission.messageId)).toBe(false);
    expect(staleStarter.state(admission.messageId)).toBe('completed');
    expect(staleCanceller.state(admission.messageId)).toBe('completed');
  });

  test('treats a cross-worker retry timestamp as the same accepted input', async () => {
    const log = new FencedMemoryLog();
    const [first, second] = await Promise.all([
      TurnAdmissionJournal.open(log),
      TurnAdmissionJournal.open(log),
    ]);
    const original = turn('msg_01', 'same input');
    original.wireUserMessage.info.time = { created: 100 };
    const retry = structuredClone(original);
    retry.wireUserMessage.info.time = { created: 200 };

    expect(await first.accept(original)).toBe(true);
    expect(await second.accept(retry)).toBe(false);
    expect(second.admission(original.messageId)).toEqual(original);
    expect(
      log.items.filter((item) => item.kind === 'journal' && item.record.type === 'accepted'),
    ).toHaveLength(1);
  });

  test('two worker journals cannot both cancel and start one pending turn', async () => {
    for (const firstTransition of ['started', 'cancelled'] as const) {
      const admission = turn(`msg_${firstTransition}`, 'same input');
      const log = new FencedMemoryLog([accepted(admission)]);
      const [starter, canceller] = await Promise.all([
        TurnAdmissionJournal.open(log),
        TurnAdmissionJournal.open(log),
      ]);
      const start = () => starter.start(admission.messageId);
      const cancel = () => canceller.cancel(admission.messageId);

      const outcomes = await Promise.all(
        firstTransition === 'started' ? [start(), cancel()] : [cancel(), start()],
      );

      expect(outcomes.filter(Boolean)).toHaveLength(1);
      const transitions: Array<'started' | 'cancelled'> = [];
      for (const item of log.items) {
        if (
          item.kind === 'journal' &&
          (item.record.type === 'started' || item.record.type === 'cancelled')
        ) {
          transitions.push(item.record.type);
        }
      }
      expect(transitions).toEqual([firstTransition]);
      const reopened = await TurnAdmissionJournal.open(log);
      expect(reopened.state(admission.messageId)).toBe(firstTransition);
    }
  });

  test('the acceptance fence rejects conflicting content from a stale worker', async () => {
    const log = new FencedMemoryLog();
    const first = await TurnAdmissionJournal.open(log);
    const stale = await TurnAdmissionJournal.open(log);
    await first.accept(turn('msg_01', 'first input'));

    await expect(stale.accept(turn('msg_01', 'different input'))).rejects.toThrow(
      'conflicting accepted payloads',
    );
    expect(
      log.items.filter((item) => item.kind === 'journal' && item.record.type === 'accepted'),
    ).toHaveLength(1);
  });

  test('a stale worker rejects a distinct id below the durable wire floor', async () => {
    const log = new FencedMemoryLog();
    const current = await TurnAdmissionJournal.open(log);
    const stale = await TurnAdmissionJournal.open(log);
    await current.accept(turn('msg_02', 'newer input'));

    await expect(stale.accept(turn('msg_01', 'older input'))).rejects.toThrow(
      'messageID must sort after the durable transcript',
    );
    expect(stale.state('msg_01')).toBe('missing');
    expect(
      log.items.filter((item) => item.kind === 'journal' && item.record.type === 'accepted'),
    ).toHaveLength(1);
  });

  test('includes durable Pi message ids in the global admission floor', async () => {
    const log = new FencedMemoryLog([
      {
        kind: 'entry',
        lane: 'main',
        entry: {
          type: 'message',
          message: {
            role: 'assistant',
            content: [],
            kortixWireMessageId: 'msg_03',
          },
        },
      },
    ]);
    const journal = await TurnAdmissionJournal.open(log);

    await expect(journal.accept(turn('msg_02', 'below Pi history'))).rejects.toThrow(
      'messageID must sort after the durable transcript',
    );
    expect(await journal.accept(turn('msg_04', 'above Pi history'))).toBe(true);
  });

  test('persists the model boundary and does not replay a started turn', async () => {
    const admission = turn('msg_01');
    const log = new MemoryLog([accepted(admission), started(admission.messageId)]);
    const journal = await TurnAdmissionJournal.open(log);

    expect(journal.state(admission.messageId)).toBe('started');
    expect(journal.pending).toEqual([]);
    expect(journal.wireMessages).toEqual([admission.wireUserMessage]);
    expect(await journal.start(admission.messageId)).toBe(false);
    expect(await journal.cancel(admission.messageId)).toBe(false);
    expect(log.items).toHaveLength(2);
  });

  test('allows legacy pending completion and normal started completion', async () => {
    const log = new MemoryLog();
    const journal = await TurnAdmissionJournal.open(log);
    const first = turn('msg_01');
    const second = turn('msg_02');

    await journal.accept(first);
    expect(await journal.complete(first.messageId)).toBe(true);
    await journal.accept(second);
    expect(await journal.start(second.messageId)).toBe(true);
    expect(await journal.complete(second.messageId)).toBe(true);

    expect(journal.state(first.messageId)).toBe('completed');
    expect(journal.state(second.messageId)).toBe('completed');
  });

  test('cancels a pending turn once and removes its user envelope', async () => {
    const log = new MemoryLog();
    const journal = await TurnAdmissionJournal.open(log);
    const admission = turn('msg_01');

    expect(await journal.accept(admission)).toBe(true);
    expect(await journal.cancel(admission.messageId)).toBe(true);
    expect(await journal.cancel(admission.messageId)).toBe(false);

    expect(journal.pending).toEqual([]);
    expect(journal.wireMessages).toEqual([]);
    expect(log.items).toHaveLength(2);
  });

  test('does not change reduced state when an append fails', async () => {
    const log = new MemoryLog();
    log.append = async () => {
      throw new Error('store unavailable');
    };
    const journal = await TurnAdmissionJournal.open(log);

    await expect(journal.accept(turn('msg_01'))).rejects.toThrow('store unavailable');
    expect(journal.state('msg_01')).toBe('missing');
    expect(journal.pending).toEqual([]);
  });

  test('does not append a completion whose wire ids conflict with durable history', async () => {
    const log = new MemoryLog();
    const journal = await TurnAdmissionJournal.open(log);
    const first = turn('msg_01');
    const second = turn('msg_02');
    await journal.accept(first);
    await journal.accept(second);

    await expect(
      journal.complete(first.messageId, [
        wireMessage(second.messageId, 'assistant', 'conflict', first.messageId),
      ]),
    ).rejects.toThrow('wire message msg_02 has conflicting persisted content');

    expect(log.items).toHaveLength(2);
    expect(journal.state(first.messageId)).toBe('pending');
  });

  test('serializes concurrent mutation requests in append order', async () => {
    const calls: string[] = [];
    let release!: () => void;
    const firstAppend = new Promise<void>((resolve) => {
      release = resolve;
    });
    const log = new MemoryLog();
    log.append = async (item) => {
      const record = (item as { record: { type: string } }).record;
      calls.push(record.type);
      if (record.type === 'accepted') await firstAppend;
      log.items.push(structuredClone(item));
    };
    const journal = await TurnAdmissionJournal.open(log);

    const accept = journal.accept(turn('msg_01'));
    const cancel = journal.cancel('msg_01');
    for (let attempt = 0; calls.length === 0 && attempt < 10; attempt += 1) {
      await Promise.resolve();
    }
    expect(calls).toEqual(['accepted']);

    release();
    expect(await accept).toBe(true);
    expect(await cancel).toBe(true);
    expect(calls).toEqual(['accepted', 'cancelled']);
    expect(journal.state('msg_01')).toBe('cancelled');
  });

  test('fails closed on conflicting accepted payloads in a persisted journal', () => {
    const original = turn('msg_01', 'first');
    const conflict = turn('msg_01', 'different');

    expect(() => reduceTurnJournal([accepted(original), accepted(conflict)])).toThrow(
      TurnJournalCorruptionError,
    );
  });

  test('rejects a wire envelope whose identity differs from the accepted turn', async () => {
    const log = new MemoryLog();
    const journal = await TurnAdmissionJournal.open(log);
    const invalid = turn('msg_01');
    invalid.wireUserMessage.info.id = 'msg_other';

    await expect(journal.accept(invalid)).rejects.toThrow(
      'wire user message id must equal turn message id',
    );
    expect(log.items).toEqual([]);
  });
});

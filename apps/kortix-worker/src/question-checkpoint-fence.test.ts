import { expect, test } from 'bun:test';
import { isDeepStrictEqual } from 'node:util';
import { SessionLogConflictError, type SessionLogItem } from './session-store.ts';
import { TurnAdmissionJournal } from './turn-journal.ts';

test.each(['question', 'permission'])(
  '%s checkpoints compete atomically with owner replacement and fence the previous worker',
  async (kind) => {
    const items: SessionLogItem[] = [];
    const byKey = new Map<string, SessionLogItem>();
    const log = {
      read: async () => structuredClone(items),
      append: async (item: SessionLogItem, options?: { idempotencyKey?: string }) => {
        const key = options?.idempotencyKey;
        const previous = key && byKey.get(key);
        if (previous) {
          if (isDeepStrictEqual(previous, item)) return;
          throw new SessionLogConflictError('fence claimed');
        }
        if (key) byKey.set(key, structuredClone(item));
        items.push(structuredClone(item));
      },
    };
    const owner = await TurnAdmissionJournal.open(log);
    await owner.accept({
      messageId: 'msg_one',
      text: 'Ask.',
      options: {},
      wireUserMessage: {
        info: { id: 'msg_one', role: 'user' },
        parts: [],
      },
    });
    await owner.start('msg_one');
    const replacement = await TurnAdmissionJournal.open(log);
    const staleLease = replacement.startedLease('msg_one')!;
    const checkpoint: SessionLogItem = {
      kind: 'journal',
      stream: `kortix.pi.${kind}-checkpoints.v1`,
      record: { type: 'opened' },
    };
    expect(await owner.appendTranscriptMutation('msg_one', checkpoint)).toBe(true);
    expect(await replacement.reclaim('msg_one', staleLease)).toBe(false);
    await replacement.refresh();
    expect(await replacement.reclaim('msg_one', replacement.startedLease('msg_one')!)).toBe(true);
    expect(await owner.appendTranscriptMutation('msg_one', checkpoint)).toBe(false);
    expect(await replacement.heartbeat('msg_one')).toBe(true);
  },
);

import { describe, expect, test } from 'bun:test';

import {
  LEGACY_QUEUE_KEY,
  MAX_MIGRATION_ATTEMPTS,
  MIGRATION_ATTEMPTS_KEY,
  type MigrateDeps,
  migrateLegacyQueueToInbox,
  parseLegacyQueue,
} from './queue-migration';

/**
 * A REAL `kortix_message_queue_v3` payload, in the exact shape
 * `message-queue-store.ts`'s `persist()`/`strip()` wrote: one record per
 * session, `pending` and `failed` arrays, `inFlightId` never persisted, and a
 * file reduced to `{ kind: 'lost' }` because a `File` cannot be serialized.
 *
 * Copied from that store's own fixture before the store was deleted. Migrating
 * a blob nobody can produce any more is exactly the code that has to be tested
 * against a specimen rather than against an idea of one.
 */
const V3_BLOB = JSON.stringify({
  ses_alpha: {
    pending: [
      {
        id: 'q_1',
        clientMessageId: 'cm_1',
        text: 'first',
        agent: 'build',
        model: { providerID: 'anthropic', modelID: 'claude' },
        variant: 'thinking',
        createdAt: 1000,
        attempts: 0,
      },
      {
        id: 'q_2',
        clientMessageId: 'cm_2',
        text: 'second',
        files: [{ kind: 'lost' }],
        createdAt: 2000,
        attempts: 0,
      },
    ],
    failed: [],
  },
  ses_beta: {
    pending: [],
    failed: [
      {
        id: 'q_3',
        clientMessageId: 'cm_3',
        text: 'other session',
        createdAt: 1500,
        attempts: 1,
        lastError: 'network down',
      },
    ],
  },
});

function storage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    read: (key: string) => map.get(key) ?? null,
    write: (key: string, value: string) => void map.set(key, value),
    remove: (key: string) => void map.delete(key),
  };
}

function deps(overrides: Partial<MigrateDeps> = {}): MigrateDeps {
  const store = storage({ [LEGACY_QUEUE_KEY]: V3_BLOB });
  return {
    read: store.read,
    write: store.write,
    remove: store.remove,
    resolve: (sessionId) => ({
      projectId: 'proj',
      sessionId,
      // Deliberately NOT the same string: the Kortix session id and the
      // OpenCode chat id are different ids, and every assertion below that
      // reads a minted `messageId` proves which of the two reached the minter.
      wireSessionId: `ses_oc_${sessionId}`,
    }),
    mintMessageId: (target) => `msg_${target.wireSessionId}`,
    enqueue: async () => ({
      prompt_id: 'p',
      state: 'queued' as const,
      message_id: 'm',
      deduped: false,
    }),
    ...overrides,
  };
}

describe('parseLegacyQueue', () => {
  test('flattens every session into ordered rows, oldest first', () => {
    const rows = parseLegacyQueue(V3_BLOB);

    expect(rows.map((r) => r.clientMessageId)).toEqual(['cm_1', 'cm_3', 'cm_2']);
    expect(rows.map((r) => r.sessionId)).toEqual(['ses_alpha', 'ses_beta', 'ses_alpha']);
  });

  test('carries the agent/model/variant captured at enqueue', () => {
    const first = parseLegacyQueue(V3_BLOB)[0];

    expect(first.agent).toBe('build');
    expect(first.model).toEqual({ providerID: 'anthropic', modelID: 'claude' });
    expect(first.variant).toBe('thinking');
  });

  test('a `lost` attachment is recorded, not silently forgotten', () => {
    // The file payload was never persisted — `strip()` wrote `{kind:'lost'}` —
    // so the reload already dropped it. Counting it is what lets the migration
    // say so instead of pretending the message was always text-only.
    const second = parseLegacyQueue(V3_BLOB).find((r) => r.clientMessageId === 'cm_2');

    expect(second?.lostAttachments).toBe(1);
    expect(second?.text).toBe('second');
  });

  test('reads nothing from null, junk, or a non-object payload', () => {
    expect(parseLegacyQueue(null)).toEqual([]);
    expect(parseLegacyQueue('{')).toEqual([]);
    expect(parseLegacyQueue('[1,2,3]')).toEqual([]);
  });

  test('drops an entry with no identity rather than POSTing an unkeyed row', () => {
    const raw = JSON.stringify({ s: { pending: [{ text: 'no id' }, { id: 'q', text: '' }] } });

    expect(parseLegacyQueue(raw)).toEqual([]);
  });

  test('keeps a command entry, and says it is one', () => {
    const raw = JSON.stringify({
      s: { pending: [{ id: 'q', clientMessageId: 'cm', text: 'args', command: { name: 'webapp' }, createdAt: 1 }] },
    });

    expect(parseLegacyQueue(raw)[0].command?.name).toBe('webapp');
  });
});

describe('migrateLegacyQueueToInbox', () => {
  test('POSTs every row in typed order and clears the key', async () => {
    const store = storage({ [LEGACY_QUEUE_KEY]: V3_BLOB });
    const sent: string[] = [];
    const result = await migrateLegacyQueueToInbox(
      deps({
        read: store.read,
        write: store.write,
        remove: store.remove,
        enqueue: async (_projectId, _sessionId, input) => {
          sent.push(input.clientMessageId);
          return { prompt_id: 'p', state: 'queued', message_id: 'm', deduped: false };
        },
      }),
    );

    // Order is the order they were typed — the inbox delivers by row age, so a
    // parallel flush would reorder the user's own messages.
    expect(sent).toEqual(['cm_1', 'cm_3', 'cm_2']);
    expect(result).toMatchObject({ migrated: 3, failed: 0, skipped: 0, cleared: true });
    expect(store.map.has(LEGACY_QUEUE_KEY)).toBe(false);
    expect(store.map.has(MIGRATION_ATTEMPTS_KEY)).toBe(false);
  });

  test('the SAME clientMessageId goes out, so a second run is a no-op', async () => {
    // The inbox keys on `prompt:<sessionId>:<clientMessageId>` with a unique
    // index, so re-POSTing one is deduped by the database rather than by a
    // latch this tab would lose on reload.
    const store = storage({ [LEGACY_QUEUE_KEY]: V3_BLOB });
    const sent: Array<{ sessionId: string; clientMessageId: string }> = [];
    const d = deps({
      read: store.read,
      write: store.write,
      remove: store.remove,
      enqueue: async (_p, sessionId, input) => {
        sent.push({ sessionId, clientMessageId: input.clientMessageId });
        return { prompt_id: 'p', state: 'queued', message_id: 'm', deduped: sent.length > 3 };
      },
    });

    await migrateLegacyQueueToInbox(d);
    const second = await migrateLegacyQueueToInbox(d);

    expect(second).toMatchObject({ migrated: 0, failed: 0, skipped: 0, cleared: false });
    expect(sent).toHaveLength(3);
    expect(sent[0]).toEqual({ sessionId: 'ses_alpha', clientMessageId: 'cm_1' });
  });

  test('a failed row keeps the key and stays in the blob', async () => {
    const store = storage({ [LEGACY_QUEUE_KEY]: V3_BLOB });
    const result = await migrateLegacyQueueToInbox(
      deps({
        read: store.read,
        write: store.write,
        remove: store.remove,
        enqueue: async (_p, _s, input) => {
          if (input.clientMessageId === 'cm_3') throw new Error('503');
          return { prompt_id: 'p', state: 'queued', message_id: 'm', deduped: false };
        },
      }),
    );

    expect(result).toMatchObject({ migrated: 2, failed: 1, cleared: false });
    expect(store.map.has(LEGACY_QUEUE_KEY)).toBe(true);
    // Only the failure survives: re-POSTing the two that landed would be a
    // no-op, but rewriting them is how a partial pass grows into a loop.
    const kept = parseLegacyQueue(store.map.get(LEGACY_QUEUE_KEY) ?? null);
    expect(kept.map((r) => r.clientMessageId)).toEqual(['cm_3']);
  });

  test('an unresolvable session is kept, never dropped', async () => {
    // Pre-step-7 blobs are keyed by the OPENCODE session id, which is not the
    // Kortix session id the inbox takes. A row whose session cannot be mapped
    // has no route to the server, and deleting it would be losing the user's
    // message to tidy up a storage key.
    const store = storage({ [LEGACY_QUEUE_KEY]: V3_BLOB });
    const result = await migrateLegacyQueueToInbox(
      deps({
        read: store.read,
        write: store.write,
        remove: store.remove,
        resolve: (sessionId) =>
          sessionId === 'ses_alpha'
            ? { projectId: 'proj', sessionId, wireSessionId: `ses_oc_${sessionId}` }
            : null,
      }),
    );

    expect(result).toMatchObject({ migrated: 2, failed: 0, skipped: 1, cleared: false });
    expect(parseLegacyQueue(store.map.get(LEGACY_QUEUE_KEY) ?? null).map((r) => r.clientMessageId)).toEqual([
      'cm_3',
    ]);
  });

  test('a `/` command is skipped and kept — it is not a prompt row', async () => {
    const raw = JSON.stringify({
      ses_alpha: {
        pending: [
          { id: 'q1', clientMessageId: 'cm_1', text: 'plain', createdAt: 1 },
          { id: 'q2', clientMessageId: 'cm_2', text: 'args', command: { name: 'webapp' }, createdAt: 2 },
        ],
        failed: [],
      },
    });
    const store = storage({ [LEGACY_QUEUE_KEY]: raw });
    const sent: string[] = [];
    const result = await migrateLegacyQueueToInbox(
      deps({
        read: store.read,
        write: store.write,
        remove: store.remove,
        enqueue: async (_p, _s, input) => {
          sent.push(input.clientMessageId);
          return { prompt_id: 'p', state: 'queued', message_id: 'm', deduped: false };
        },
      }),
    );

    expect(sent).toEqual(['cm_1']);
    expect(result).toMatchObject({ migrated: 1, skipped: 1, cleared: false });
  });

  test('a row at its own attempt cap is kept and reported, never retried', async () => {
    const store = storage({
      [LEGACY_QUEUE_KEY]: V3_BLOB,
      [MIGRATION_ATTEMPTS_KEY]: JSON.stringify({
        cm_1: MAX_MIGRATION_ATTEMPTS,
        cm_2: MAX_MIGRATION_ATTEMPTS,
        cm_3: MAX_MIGRATION_ATTEMPTS,
      }),
    });
    let calls = 0;
    const errors: string[] = [];
    const result = await migrateLegacyQueueToInbox(
      deps({
        read: store.read,
        write: store.write,
        remove: store.remove,
        enqueue: async () => {
          calls += 1;
          return { prompt_id: 'p', state: 'queued', message_id: 'm', deduped: false };
        },
        onError: (message) => errors.push(message),
      }),
    );

    expect(calls).toBe(0);
    expect(result).toMatchObject({ migrated: 0, failed: 0, stranded: 3, cleared: false });
    expect(store.map.has(LEGACY_QUEUE_KEY)).toBe(true);
    expect(errors).toHaveLength(3);
  });

  test('ONE poison row does not strand any other row', async () => {
    // The failure the per-row counter exists for. A global counter let an
    // undeliverable row for one session burn the whole budget, so the row of a
    // session that had not even been opened yet was never POSTed again — on
    // this load or any future one.
    const store = storage({
      [LEGACY_QUEUE_KEY]: V3_BLOB,
      [MIGRATION_ATTEMPTS_KEY]: JSON.stringify({ cm_1: MAX_MIGRATION_ATTEMPTS }),
    });
    const sent: string[] = [];
    const result = await migrateLegacyQueueToInbox(
      deps({
        read: store.read,
        write: store.write,
        remove: store.remove,
        enqueue: async (_p, _s, input) => {
          sent.push(input.clientMessageId);
          return { prompt_id: 'p', state: 'queued', message_id: 'm', deduped: false };
        },
      }),
    );

    expect(sent).toEqual(['cm_3', 'cm_2']);
    expect(result).toMatchObject({ migrated: 2, stranded: 1, cleared: false });
    // The poison row is the only thing left in the blob, and its counter is
    // the only thing left in the attempts record.
    expect(
      parseLegacyQueue(store.map.get(LEGACY_QUEUE_KEY) ?? null).map((r) => r.clientMessageId),
    ).toEqual(['cm_1']);
    expect(JSON.parse(store.map.get(MIGRATION_ATTEMPTS_KEY) ?? '{}')).toEqual({
      cm_1: MAX_MIGRATION_ATTEMPTS,
    });
  });

  test('a pre-fix global counter is discarded rather than charged to every row', async () => {
    // The old format was a bare count. It names no row, so there is nothing to
    // attribute it to — and attributing it to all of them is the bug.
    const store = storage({
      [LEGACY_QUEUE_KEY]: V3_BLOB,
      [MIGRATION_ATTEMPTS_KEY]: String(MAX_MIGRATION_ATTEMPTS),
    });
    const sent: string[] = [];
    await migrateLegacyQueueToInbox(
      deps({
        read: store.read,
        write: store.write,
        remove: store.remove,
        enqueue: async (_p, _s, input) => {
          sent.push(input.clientMessageId);
          return { prompt_id: 'p', state: 'queued', message_id: 'm', deduped: false };
        },
      }),
    );

    expect(sent).toEqual(['cm_1', 'cm_3', 'cm_2']);
    expect(store.map.has(MIGRATION_ATTEMPTS_KEY)).toBe(false);
  });

  test('counts the attempt BEFORE the POSTs, so a crash mid-pass still counts', async () => {
    const store = storage({ [LEGACY_QUEUE_KEY]: V3_BLOB });
    await migrateLegacyQueueToInbox(
      deps({
        read: store.read,
        write: store.write,
        remove: store.remove,
        enqueue: async () => {
          // Read the counter from inside the pass: a counter written only on
          // the way out never increments for the failure mode it exists to
          // bound — a pass that never returns.
          expect(JSON.parse(store.map.get(MIGRATION_ATTEMPTS_KEY) ?? '{}').cm_1).toBe(1);
          throw new Error('boom');
        },
      }),
    );

    expect(JSON.parse(store.map.get(MIGRATION_ATTEMPTS_KEY) ?? '{}').cm_1).toBe(1);
  });

  test('a skip-only pass gives the attempt back', async () => {
    // Every open session tab runs a pass and sees only its OWN rows. Counting
    // another session's skips would exhaust the cap before the session that
    // owns the row is ever opened.
    const store = storage({ [LEGACY_QUEUE_KEY]: V3_BLOB });
    await migrateLegacyQueueToInbox(
      deps({ read: store.read, write: store.write, remove: store.remove, resolve: () => null }),
    );

    expect(store.map.has(MIGRATION_ATTEMPTS_KEY)).toBe(false);
    expect(store.map.has(LEGACY_QUEUE_KEY)).toBe(true);
  });

  test('a failing pass keeps its attempt', async () => {
    const store = storage({ [LEGACY_QUEUE_KEY]: V3_BLOB });
    await migrateLegacyQueueToInbox(
      deps({
        read: store.read,
        write: store.write,
        remove: store.remove,
        enqueue: async () => {
          throw new Error('503');
        },
      }),
    );

    expect(JSON.parse(store.map.get(MIGRATION_ATTEMPTS_KEY) ?? '{}')).toEqual({
      cm_1: 1,
      cm_2: 1,
      cm_3: 1,
    });
  });

  test('does nothing at all when there is no legacy blob', async () => {
    const store = storage();
    const result = await migrateLegacyQueueToInbox(
      deps({ read: store.read, write: store.write, remove: store.remove }),
    );

    expect(result).toMatchObject({ migrated: 0, failed: 0, skipped: 0, stranded: 0, cleared: false });
    expect(store.map.size).toBe(0);
  });

  test('clears a blob that holds nothing recoverable', async () => {
    const store = storage({ [LEGACY_QUEUE_KEY]: '{"ses_a":{"pending":[],"failed":[]}}' });
    const result = await migrateLegacyQueueToInbox(
      deps({ read: store.read, write: store.write, remove: store.remove }),
    );

    expect(result.cleared).toBe(true);
    expect(store.map.has(LEGACY_QUEUE_KEY)).toBe(false);
  });

  test('sends the text and the captured overrides as one prompt part', async () => {
    const store = storage({ [LEGACY_QUEUE_KEY]: V3_BLOB });
    const bodies: unknown[] = [];
    await migrateLegacyQueueToInbox(
      deps({
        read: store.read,
        write: store.write,
        remove: store.remove,
        enqueue: async (projectId, sessionId, input) => {
          bodies.push({ projectId, sessionId, ...input });
          return { prompt_id: 'p', state: 'queued', message_id: 'm', deduped: false };
        },
      }),
    );

    expect(bodies[0]).toEqual({
      projectId: 'proj',
      sessionId: 'ses_alpha',
      clientMessageId: 'cm_1',
      // Minted under the OPENCODE chat id, not the Kortix session id: the
      // transcript the minter lifts the id above is keyed by the former only,
      // so minting under the latter silently returns a 2-minute-backdated id.
      messageId: 'msg_ses_oc_ses_alpha',
      parts: [{ type: 'text', text: 'first' }],
      overrides: {
        agent: 'build',
        model: { providerID: 'anthropic', modelID: 'claude' },
        variant: 'thinking',
      },
      // The id above was minted at page load for a message typed before the
      // last reload. Only the control plane, reading the live root, can place
      // it above what is already on record.
      remintOnDelivery: true,
    });
  });
});

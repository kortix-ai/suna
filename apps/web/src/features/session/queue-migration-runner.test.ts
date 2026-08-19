import { describe, expect, test } from 'bun:test';

import { LEGACY_QUEUE_KEY } from './queue-migration';
import { type MigrationStorage, runLegacyQueueMigration } from './queue-migration-runner';

/**
 * The runner is pure wiring, and wiring is exactly where the id bug lived: it
 * minted the OpenCode wire message id under the KORTIX session id. That mint
 * looks up the transcript in the sync store, which is keyed by the OPENCODE
 * chat id, so the lookup always missed, the 2-minute clock backdate was never
 * lifted, and the migrated prompt could sort below the transcript — which
 * OpenCode reads as already answered, so the turn never runs and the message
 * the migration exists to rescue is lost with no error.
 *
 * `queue-migration.test.ts` cannot catch that: it injects `mintMessageId`.
 */

const KORTIX_ID = '11111111-2222-4333-8444-555555555555';
const OPENCODE_ID = 'ses_9f3a';

function storage(seed: Record<string, string> = {}): MigrationStorage & { map: Map<string, string> } {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

const BLOB = JSON.stringify({
  [OPENCODE_ID]: {
    pending: [{ id: 'q_1', clientMessageId: 'cm_1', text: 'ship it', createdAt: 1 }],
    failed: [],
  },
});

describe('runLegacyQueueMigration', () => {
  test('mints the wire id under the OPENCODE chat id, not the Kortix session id', async () => {
    const store = storage({ [LEGACY_QUEUE_KEY]: BLOB });
    const mintedFor: string[] = [];
    const posted: Array<{ clientMessageId: string; messageId: string }> = [];

    await runLegacyQueueMigration({
      legacyIds: [OPENCODE_ID, KORTIX_ID],
      projectId: 'proj',
      sessionId: KORTIX_ID,
      wireSessionId: OPENCODE_ID,
      enqueue: async (input) => {
        posted.push({ clientMessageId: input.clientMessageId, messageId: input.messageId });
        return { prompt_id: 'p', state: 'queued', message_id: input.messageId, deduped: false };
      },
      adapters: {
        storage: store,
        mint: (id) => {
          mintedFor.push(id);
          return `msg_${id}`;
        },
      },
    });

    expect(mintedFor).toEqual([OPENCODE_ID]);
    expect(posted).toEqual([{ clientMessageId: 'cm_1', messageId: `msg_${OPENCODE_ID}` }]);
  });

  test('POSTs to the KORTIX session id and asks the server to re-mint', async () => {
    // The two halves of the same fact: the route only takes the Kortix id, and
    // the id minted here — at page load, for a message typed before the last
    // reload — is placed by the control plane against the live root.
    const store = storage({ [LEGACY_QUEUE_KEY]: BLOB });
    const inputs: Array<Record<string, unknown>> = [];

    await runLegacyQueueMigration({
      legacyIds: [OPENCODE_ID, KORTIX_ID],
      projectId: 'proj',
      sessionId: KORTIX_ID,
      wireSessionId: OPENCODE_ID,
      enqueue: async (input) => {
        inputs.push(input as unknown as Record<string, unknown>);
        return { prompt_id: 'p', state: 'queued', message_id: input.messageId, deduped: false };
      },
      adapters: { storage: store, mint: (id) => `msg_${id}` },
    });

    expect(inputs).toHaveLength(1);
    expect(inputs[0].remintOnDelivery).toBe(true);
    // The blob is gone: nothing was left to migrate.
    expect(store.map.has(LEGACY_QUEUE_KEY)).toBe(false);
  });

  test('a row belonging to another session is left alone, not re-keyed onto this one', async () => {
    const store = storage({
      [LEGACY_QUEUE_KEY]: JSON.stringify({
        ses_other: {
          pending: [{ id: 'q_9', clientMessageId: 'cm_9', text: 'not mine', createdAt: 1 }],
          failed: [],
        },
      }),
    });
    let posts = 0;

    await runLegacyQueueMigration({
      legacyIds: [OPENCODE_ID, KORTIX_ID],
      projectId: 'proj',
      sessionId: KORTIX_ID,
      wireSessionId: OPENCODE_ID,
      enqueue: async () => {
        posts += 1;
        return { prompt_id: 'p', state: 'queued', message_id: 'm', deduped: false };
      },
      adapters: { storage: store, mint: (id) => `msg_${id}` },
    });

    expect(posts).toBe(0);
    expect(store.map.has(LEGACY_QUEUE_KEY)).toBe(true);
  });

  test('no storage at all (SSR, private mode) is a no-op, not a throw', async () => {
    await expect(
      runLegacyQueueMigration({
        legacyIds: [OPENCODE_ID],
        projectId: 'proj',
        sessionId: KORTIX_ID,
        wireSessionId: OPENCODE_ID,
        enqueue: async () => {
          throw new Error('must not be called');
        },
        adapters: { storage: null },
      }),
    ).resolves.toBeUndefined();
  });
});

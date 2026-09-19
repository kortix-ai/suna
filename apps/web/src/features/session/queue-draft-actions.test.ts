import type { SessionPrompt } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';

import { postThenDropLocalCopy, removeQueuedDraftSend } from './queue-draft-actions';

function prompt(over: Partial<SessionPrompt> = {}): SessionPrompt {
  return {
    prompt_id: 'cmd-1',
    client_message_id: 'q_1',
    message_id: 'msg_a',
    state: 'queued',
    reason: null,
    text: 'say hi',
    attempts: 0,
    last_error: null,
    created_at: '2026-08-18T00:00:00.000Z',
    available_at: '2026-08-18T00:00:00.000Z',
    ...over,
  };
}

/** Every call the removal makes, in the order it made them. */
function harness(
  over: Partial<Parameters<typeof removeQueuedDraftSend>[0]> = {},
  heldSend: { attachments?: { release?: () => void } } | null = { attachments: {} },
) {
  const trace: string[] = [];
  const args: Record<string, unknown[]> = {};
  const record =
    <T extends unknown[]>(name: string, result?: unknown) =>
    (...call: T) => {
      trace.push(name);
      args[name] = call;
      return result;
    };
  const send = heldSend
    ? { ...heldSend, attachments: heldSend.attachments && { release: record('release') } }
    : undefined;
  const input = {
    sessionId: 'ses_1',
    clientMessageId: 'q_1',
    messageId: 'msg_wire',
    failures: {
      failuresBySession: send ? { ses_1: { msg_wire: { send } } } : {},
      clearHeldSendFailure: record('clearHeldSendFailure'),
    },
    drafts: { remove: record('removeDraft') },
    announceRemoved: record('announceRemoved'),
    listedPrompts: () => [] as readonly SessionPrompt[],
    fetchPrompts: null,
    removePrompt: record('removePrompt', Promise.resolve()) as (
      promptId: string,
    ) => Promise<unknown>,
    ...over,
  } as Parameters<typeof removeQueuedDraftSend>[0];
  return { input, trace, args };
}

describe('removeQueuedDraftSend', () => {
  test('lets go of the local copies FIRST, then hunts for a row a lost POST created', async () => {
    // Order is the contract: the row has to leave the list on the click, not
    // after a network round trip that may never answer.
    const { input, trace, args } = harness({
      listedPrompts: () => [prompt({ prompt_id: 'cmd-9', client_message_id: 'q_1' })],
    });
    await removeQueuedDraftSend(input);
    expect(trace).toEqual([
      'release',
      'clearHeldSendFailure',
      'removeDraft',
      'announceRemoved',
      'removePrompt',
    ]);
    expect(args.clearHeldSendFailure).toEqual(['ses_1', 'msg_wire']);
    expect(args.removeDraft).toEqual(['ses_1', ['q_1']]);
    // The DELETE matches `prompt_id`, never the wire id this send knew itself by.
    expect(args.removePrompt).toEqual(['cmd-9']);
  });

  test('says "Removed from queue" even when no server row was ever created', async () => {
    // A draft removal and a row removal are the same button on two rows that
    // look identical. Silence on one of them reads as a click that did nothing.
    const { input, trace, args } = harness();
    await removeQueuedDraftSend(input);
    expect(trace).toEqual(['release', 'clearHeldSendFailure', 'removeDraft', 'announceRemoved']);
    expect(args.removePrompt).toBeUndefined();
  });

  test('reads the server once when the inbox this tab holds has no row for the send', async () => {
    let fetched = 0;
    const { input, args } = harness({
      fetchPrompts: async () => {
        fetched += 1;
        return [prompt({ prompt_id: 'cmd-lost', client_message_id: 'q_1' })];
      },
    });
    await removeQueuedDraftSend(input);
    expect(fetched).toBe(1);
    expect(args.removePrompt).toEqual(['cmd-lost']);
  });

  test('never reads the server when the inbox already names the row', async () => {
    let fetched = 0;
    const { input, args } = harness({
      listedPrompts: () => [prompt({ prompt_id: 'cmd-here', client_message_id: 'q_1' })],
      fetchPrompts: async () => {
        fetched += 1;
        return [];
      },
    });
    await removeQueuedDraftSend(input);
    expect(fetched).toBe(0);
    expect(args.removePrompt).toEqual(['cmd-here']);
  });

  test('a send with no kept failure still drops its draft', async () => {
    // A draft can outlive its failure — a Retry cleared it and the re-send is
    // on the wire. Remove still has to take the row away.
    const { input, trace } = harness({}, null);
    await removeQueuedDraftSend(input);
    expect(trace).toEqual(['clearHeldSendFailure', 'removeDraft', 'announceRemoved']);
  });

  test('a refused DELETE is swallowed: this tab’s copy is gone either way', async () => {
    const { input } = harness({
      listedPrompts: () => [prompt({ prompt_id: 'cmd-404', client_message_id: 'q_1' })],
      removePrompt: async () => {
        throw Object.assign(new Error('Not found'), { status: 404 });
      },
    });
    await expect(removeQueuedDraftSend(input)).resolves.toBeUndefined();
  });

  test('a server read that throws never strands the removal', async () => {
    const { input, trace } = harness({
      fetchPrompts: async () => {
        throw new Error('offline');
      },
    });
    await removeQueuedDraftSend(input);
    expect(trace).toEqual(['release', 'clearHeldSendFailure', 'removeDraft', 'announceRemoved']);
  });
});

/**
 * A painted send that POSTs detached — it carries uploads, or waits behind an
 * earlier send — used to keep its local copy for the rest of the shell's life.
 * It was hidden only while the inbox still listed the row, so a Remove un-hid
 * it and redrew a bubble the "Removed from queue" toast said was gone.
 */
describe('postThenDropLocalCopy', () => {
  test('the local copy goes only after the server owns the row', async () => {
    const trace: string[] = [];
    const post = postThenDropLocalCopy(
      async () => {
        trace.push('post');
        return 'accepted';
      },
      () => trace.push('drop'),
    );

    await expect(post([])).resolves.toBe('accepted');
    expect(trace).toEqual(['post', 'drop']);
  });

  test('a refused POST keeps the local copy — its Retry has nothing else to act on', async () => {
    const trace: string[] = [];
    const post = postThenDropLocalCopy(
      async () => {
        throw new Error('refused');
      },
      () => trace.push('drop'),
    );

    await expect(post([])).rejects.toThrow('refused');
    expect(trace).toEqual([]);
  });
});

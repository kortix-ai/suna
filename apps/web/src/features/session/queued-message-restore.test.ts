import { describe, expect, test } from 'bun:test';
import type { CreateSessionPromptInput, RemovedSessionPrompt } from '@kortix/sdk';
import { createQueueUndoAction, restoreQueuedMessage } from './queued-message-restore';

function removed(overrides: Partial<RemovedSessionPrompt> = {}): RemovedSessionPrompt {
  return {
    prompt_id: 'cmd_1',
    client_message_id: 'cm_1',
    message_id: 'msg_1',
    parts: [
      { type: 'text', text: 'ship it' },
      { type: 'file', filename: 'a.png', mime: 'image/png', url: 'https://x/a.png' },
    ],
    overrides: { agent: 'build', model: { providerID: 'anthropic', modelID: 'claude' } },
    ...overrides,
  };
}

describe('restoreQueuedMessage', () => {
  test('re-POSTs the ORIGINAL parts and overrides, not a rebuilt preview', () => {
    // REWRITTEN for the server inbox. This used to reconstruct a browser-store
    // entry by subtracting the store's own bookkeeping from it. There is no
    // store; the DELETE response is the whole body, and rebuilding it from the
    // list row would silently drop attachments and the model picks.
    const body = removed();

    expect(restoreQueuedMessage(body, () => 'msg_fresh')).toEqual({
      clientMessageId: 'cm_1',
      messageId: 'msg_fresh',
      parts: body.parts,
      overrides: body.overrides!,
    });
  });

  test('keeps the clientMessageId, so a repeated undo is one row', () => {
    // `prompt:<sessionId>:<clientMessageId>` is the inbox's unique idempotency
    // key. Minting a new one here would make Undo a second send.
    expect(restoreQueuedMessage(removed(), () => 'msg_fresh').clientMessageId).toBe('cm_1');
  });

  test('mints a FRESH wire messageId, because OpenCode orders by id', () => {
    // The original id was minted when the row was first queued. By the time
    // Undo is pressed the agent may have written a whole turn's worth of
    // higher ids — a stop, then a remove, then an undo is the ordinary way
    // this happens — and OpenCode reads a prompt whose id sorts below the
    // transcript as ALREADY ANSWERED: the row is marked succeeded, drops out
    // of `GET /prompts`, and never runs. A re-queued prompt belongs at the end
    // of the transcript, which is exactly where a fresh mint puts it.
    expect(restoreQueuedMessage(removed(), () => 'msg_fresh').messageId).toBe('msg_fresh');
  });

  test('omits `overrides` entirely when the prompt carried none', () => {
    // `undefined` and `{}` are not the same downstream: an empty object would
    // send "no agent, no model" rather than "resolve at delivery".
    expect(restoreQueuedMessage(removed({ overrides: null }), () => 'msg_fresh')).not.toHaveProperty(
      'overrides',
    );
  });
});

describe('createQueueUndoAction', () => {
  test('re-creates the prompt and dismisses its toast', () => {
    const sent: CreateSessionPromptInput[] = [];
    const dismissed: number[] = [];
    const undo = createQueueUndoAction({
      removed: removed(),
      mintMessageId: () => 'msg_fresh',
      enqueue: async (input) => void sent.push(input),
      dismiss: () => dismissed.push(1),
    });

    undo();

    expect(sent).toHaveLength(1);
    expect(sent[0].clientMessageId).toBe('cm_1');
    expect(sent[0].messageId).toBe('msg_fresh');
    expect(dismissed).toHaveLength(1);
  });

  test('a second press does nothing — the button outlives the dismiss animation', () => {
    const sent: CreateSessionPromptInput[] = [];
    const undo = createQueueUndoAction({
      removed: removed(),
      mintMessageId: () => 'msg_fresh',
      enqueue: async (input) => void sent.push(input),
    });

    undo();
    undo();
    undo();

    expect(sent).toHaveLength(1);
  });

  test('a refused restore reports instead of throwing into the click handler', async () => {
    const errors: unknown[] = [];
    const undo = createQueueUndoAction({
      removed: removed(),
      mintMessageId: () => 'msg_fresh',
      enqueue: async () => {
        throw new Error('409');
      },
      onError: (cause) => errors.push(cause),
    });

    undo();
    await Promise.resolve();
    await Promise.resolve();

    expect(errors).toHaveLength(1);
  });
});

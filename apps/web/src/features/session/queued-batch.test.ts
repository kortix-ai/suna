import { describe, expect, test } from 'bun:test';

import type { WebQueuedMessage } from '@/stores/message-queue-store';
import { mergeQueuedBatch } from './queued-batch';

function message(text: string, extra: Partial<WebQueuedMessage> = {}): WebQueuedMessage {
  return {
    id: `q_${text}`,
    clientMessageId: `cm_${text}`,
    text,
    createdAt: 0,
    attempts: 1,
    ...extra,
  };
}

describe('mergeQueuedBatch', () => {
  test('joins the queue into one prompt, in the order it was typed', () => {
    // The whole point. Three messages typed during a turn reach the agent
    // together on the next one, not one per turn.
    const merged = mergeQueuedBatch([
      message('fix the failing test'),
      message('also update the docs'),
      message('then push it'),
    ]);

    expect(merged?.text).toBe('fix the failing test\n\nalso update the docs\n\nthen push it');
  });

  test('a single queued message is sent verbatim, with no separator added', () => {
    expect(mergeQueuedBatch([message('just the one')])?.text).toBe('just the one');
  });

  test('an empty batch produces nothing to send', () => {
    expect(mergeQueuedBatch([])).toBeNull();
  });

  test('carries the agent, model and variant captured at enqueue', () => {
    const model = { providerID: 'anthropic', modelID: 'claude-opus-5' };
    const merged = mergeQueuedBatch([
      message('first', { agent: 'build', model, variant: 'thinking' }),
      message('second', { agent: 'build', model, variant: 'thinking' }),
    ]);

    expect(merged?.overrides).toEqual({
      agent: 'build',
      model,
      variant: 'thinking',
      clientMessageId: 'cm_first',
    });
  });

  test('carries the head entry`s clientMessageId, so a retried entry re-sends one wire messageID', () => {
    // A retry preserves `clientMessageId` (the store moves the entry, it does
    // not re-create it). Sending it again makes the retried request body
    // byte-identical, so the proxy's body-hash dedupe absorbs a prompt the
    // server already accepted instead of delivering it twice.
    const merged = mergeQueuedBatch([message('first'), message('second')]);

    expect(merged?.overrides.clientMessageId).toBe('cm_first');
  });

  test('preserves the difference between an unresolved and an absent capture', () => {
    // `undefined` means "resolve at send time"; `null` means "send none".
    // Flattening either into the other strips the user's model from the send.
    expect(mergeQueuedBatch([message('a')])?.overrides).toEqual({
      agent: undefined,
      model: undefined,
      variant: undefined,
      clientMessageId: 'cm_a',
    });
    expect(mergeQueuedBatch([message('a', { agent: null })])?.overrides.agent).toBeNull();
  });

  test('collects the attachments of every message in the batch', () => {
    const one = { kind: 'remote' as const, url: 'u1', filename: 'a.png', mime: 'image/png', isImage: true };
    const two = { kind: 'remote' as const, url: 'u2', filename: 'b.png', mime: 'image/png', isImage: true };
    const merged = mergeQueuedBatch([
      message('first', { files: [one] }),
      message('second', { files: [two] }),
    ]);

    expect(merged?.files?.map((f) => (f.kind === 'remote' ? f.filename : null))).toEqual([
      'a.png',
      'b.png',
    ]);
  });

  test('drops attachments that did not survive being stored', () => {
    // A `lost` marker carries no data. Sending the text beats sending a broken
    // attachment; the composer already tells the user the file was dropped.
    const merged = mergeQueuedBatch([
      message('after a reload', { files: [{ kind: 'lost' }, { kind: 'lost' }] }),
    ]);

    expect(merged?.files).toBeUndefined();
  });

  test('lists a file mentioned in two messages once', () => {
    // One `<file_ref />` block goes out per prompt. Listing the same path twice
    // is noise the agent has to reconcile.
    const merged = mergeQueuedBatch([
      message('look at this', { mentions: [{ kind: 'file', label: 'src/a.ts', value: 'src/a.ts' }] }),
      message('and again', { mentions: [{ kind: 'file', label: 'src/a.ts', value: 'src/a.ts' }] }),
    ]);

    expect(merged?.mentions).toEqual([{ kind: 'file', label: 'src/a.ts', value: 'src/a.ts' }]);
  });

  test('keeps distinct mentions from across the batch', () => {
    const merged = mergeQueuedBatch([
      message('one', { mentions: [{ kind: 'file', label: 'src/a.ts', value: 'src/a.ts' }] }),
      message('two', { mentions: [{ kind: 'agent', label: 'reviewer', value: 'reviewer' }] }),
    ]);

    expect(merged?.mentions?.map((m) => m.label)).toEqual(['src/a.ts', 'reviewer']);
  });

  test('sends no mentions rather than an empty list', () => {
    // `handleSend` branches on presence, so an empty array is not the same as
    // nothing — it would append an empty refs block.
    expect(mergeQueuedBatch([message('plain')])?.mentions).toBeUndefined();
  });
});

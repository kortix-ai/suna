import { describe, expect, test } from 'bun:test';

import { serializePrompt } from './session-prompt-view';

function row(payload: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    commandId: 'cmd-1',
    payload,
    result: {},
    attempts: 0,
    lastError: null,
    createdAt: new Date('2026-09-04T15:06:47.900Z'),
    availableAt: new Date('2026-09-04T15:06:47.900Z'),
    ...overrides,
    // biome-ignore lint/suspicious/noExplicitAny: test row stands in for the DB shape
  } as any;
}

describe('serializePrompt attachments', () => {
  // A reload throws away the composer's optimistic bubble, so the durable row
  // is the ONLY thing that can still say a prompt had attachments. It carried
  // `text` and nothing else, which is why a refreshed tab showed a bare
  // sentence for a send of seven files (2026-09-04).
  test('names every attachment without carrying its bytes', () => {
    const view = serializePrompt(
      row({
        text: 'YO BRO',
        parts: [
          { type: 'text', text: 'YO BRO' },
          {
            type: 'file',
            mime: 'image/jpeg',
            filename: '20260830_134945.jpg',
            url: `data:image/jpeg;base64,${'A'.repeat(4000)}`,
          },
          { type: 'file', mime: 'application/pdf', filename: 'spec.pdf', url: 'data:x' },
        ],
      }),
    );

    expect(view.attachments).toEqual([
      { filename: '20260830_134945.jpg', mime: 'image/jpeg' },
      { filename: 'spec.pdf', mime: 'application/pdf' },
    ]);
    // The bytes must never ride along: this view is polled, and a 1.4 MB data
    // URL per prompt would be re-sent on every poll.
    expect(JSON.stringify(view)).not.toContain('AAAA');
  });

  test('is an empty list for a text-only prompt', () => {
    expect(serializePrompt(row({ text: 'hi', parts: [{ type: 'text', text: 'hi' }] })).attachments)
      .toEqual([]);
    expect(serializePrompt(row({ text: 'hi' })).attachments).toEqual([]);
  });

  test('falls back to a readable name when the part has none', () => {
    const view = serializePrompt(
      row({ text: 'x', parts: [{ type: 'file', mime: 'image/png', url: 'data:x' }] }),
    );
    expect(view.attachments).toEqual([{ filename: 'File', mime: 'image/png' }]);
  });
});

/**
 * WHICH HOLD IS THIS? The wire has to answer it, because `reason: 'held'`
 * cannot.
 *
 * Cmd/Ctrl+Enter parks a prompt by holding it, so a parked row and a
 * stop-paused row are the same `reason`. A client that read `held` as
 * "stopped" lit "Queue paused — Resume" the first time anyone parked a
 * message; the client that fixed that by excluding `queued_by_user` rows then
 * went blind to a real Stop on a queue where every row is parked — this
 * feature's normal state. `stop_held` is the separate fact.
 */
describe('serializePrompt stop_held', () => {
  test('a parked row is NOT stop-held', () => {
    const view = serializePrompt(row({ text: 'hi', queuedByUser: true }, { result: { held: true } }));
    expect(view.queued_by_user).toBe(true);
    expect(view.reason).toBe('held');
    expect(view.stop_held).toBe(false);
  });

  test('a parked row the STOP button also caught IS stop-held', () => {
    // `holdInboxPrompts(sessionId, true)` stamps every queued row, parked ones
    // included — it is a session-wide pause. Without this the composer showed
    // no Resume at all for a stopped session whose queue was all parked.
    const view = serializePrompt(
      row({ text: 'hi', queuedByUser: true }, { result: { held: true, stop_held: true } }),
    );
    expect(view.queued_by_user).toBe(true);
    expect(view.stop_held).toBe(true);
  });

  test('an ordinary queued row reports both flags false, never absent', () => {
    // Always present: a client must not have to tell "not stopped" from "old
    // server that never sent the field".
    const view = serializePrompt(row({ text: 'hi' }));
    expect(view.stop_held).toBe(false);
    expect(view.queued_by_user).toBe(false);
  });
});

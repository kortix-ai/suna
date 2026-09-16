import { describe, expect, test } from 'bun:test';

import { promptState, serializePrompt } from './session-prompt-view';

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

test('reload preserves placement and full code text while keeping the legacy preview bounded', () => {
  const text = '  const result = await run();\n'.repeat(120);
  const view = serializePrompt(row({ text, placement: 'transcript' }));
  expect(view.placement).toBe('transcript');
  expect(view.full_text).toBe(text);
  expect(view.text).toHaveLength(2000);
  expect(serializePrompt(row({ text: 'old row' })).placement).toBe('composer');
});


test('legacy delivery failures expose a readable cause on reload', () => {
  expect(serializePrompt(row({}, { status: 'dead_lettered', lastError: 'delivery outcome: pending' })).last_error)
    .toBe('the session was not ready in time');
  expect(serializePrompt(row({}, { status: 'dead_lettered', lastError: 'Connector access is unavailable' })).last_error)
    .toBe('Connector access is unavailable');
});


describe('worker claims are not delivery', () => {
  test('the admission check keeps a waiting prompt waiting', () => {
    expect(promptState({ status: 'running', result: { admission_reason: 'turn_active' } }))
      .toEqual({ state: 'waiting', reason: 'turn_active' });
    expect(promptState({ status: 'running', result: {} }))
      .toEqual({ state: 'queued', reason: null });
  });

  test('only an admitted delivery reports sending', () => {
    expect(promptState({ status: 'running', result: {
      admission_reason: 'turn_active', delivery_started_at: '2026-09-16T10:00:00.000Z',
    } })).toEqual({ state: 'delivering', reason: null });
  });
});

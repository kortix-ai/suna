import { describe, expect, test } from 'bun:test';
import type { SessionLogMessage } from '@kortix/sdk';
import { serializePromptWithPastes } from '@kortix/shared';

import { promptHistoryEntries, stepPromptHistory } from './prompt-history';
import { uploadedFileRefXml } from './uploaded-file-refs';

function message(over: Partial<SessionLogMessage> & { text?: string }): SessionLogMessage {
  const { text = '', ...rest } = over;
  return {
    message_id: Math.random().toString(36),
    thread_id: 't',
    seq: 0,
    role: 'user',
    kind: 'turn',
    status: 'complete',
    in_context: true,
    model: null,
    usage: null,
    finish: null,
    error: null,
    created_at: '2026-11-04T00:00:00Z',
    completed_at: null,
    producer: { harness: 'pi', harness_version: '0', adapter_version: '0' },
    blocks: [{ id: 'b', type: 'text', text }],
    ...rest,
  } as SessionLogMessage;
}

describe('promptHistoryEntries', () => {
  test('keeps typed user prompts as text, oldest first', () => {
    const upload = uploadedFileRefXml({ path: '/workspace/uploads/a.png', mime: 'image/png', filename: 'a.png' });
    const entries = promptHistoryEntries([
      message({ text: 'hi' }),
      message({ role: 'assistant', text: 'hello' }),
      message({ text: `${upload}` }),
      message({ text: `look at this\n\n${upload}` }),
      message({ text: 'from a trigger', origin: 'automation' }),
      message({ text: serializePromptWithPastes('kaise ho', [{ id: 'p', text: 'pasted body' }]) }),
    ]);
    expect(entries).toEqual(['hi', 'look at this', 'kaise ho']);
  });
});

describe('stepPromptHistory', () => {
  test('Up starts at the newest and stops at the oldest', () => {
    expect(stepPromptHistory(null, 'up', 3)).toBe(2);
    expect(stepPromptHistory(1, 'up', 3)).toBe(0);
    expect(stepPromptHistory(0, 'up', 3)).toBe(0);
  });

  test('Down walks back to the draft, and is not history from the draft', () => {
    expect(stepPromptHistory(0, 'down', 3)).toBe(1);
    expect(stepPromptHistory(2, 'down', 3)).toBeNull();
    expect(stepPromptHistory(null, 'down', 3)).toBeUndefined();
  });

  test('no entries: neither key is history', () => {
    expect(stepPromptHistory(null, 'up', 0)).toBeUndefined();
  });
});

import { describe, expect, test } from 'bun:test';

import type { QueueRow } from '../queue-projection';
import { queuedRowActions } from './queued-prompt-list';

const row = (over: Partial<QueueRow> & { id: string }): QueueRow => ({
  clientMessageId: `c-${over.id}`,
  text: `text ${over.id}`,
  attachmentCount: 0,
  state: 'queued',
  removable: true,
  retryable: over.state === 'failed',
  interruptible: true,
  takeBackEligible: true,
  rawText: over.text ?? `text ${over.id}`,
  editText: over.text ?? `text ${over.id}`,
  ...over,
});

describe('choosing a menu action', () => {
  test('each menu item runs its handler with THAT row id, and only that row', () => {
    const calls: string[] = [];
    const handlers = {
      onEdit: (id: string) => calls.push(`edit:${id}`),
      onRetry: (id: string) => calls.push(`retry:${id}`),
      onStopAndSend: (id: string) => calls.push(`stop:${id}`),
      onRemove: (id: string) => calls.push(`remove:${id}`),
    };
    queuedRowActions(row({ id: 'a' }), handlers);
    for (const action of queuedRowActions(row({ id: 'b' }), handlers)) action.run();
    expect(calls).toEqual(['edit:b', 'retry:b', 'stop:b', 'remove:b']);
  });
});

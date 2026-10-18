import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionLogMessage } from '@kortix/sdk';
import { MessageView } from '../../src/components/chat/message-view';

const message = (blocks: SessionLogMessage['blocks']): SessionLogMessage => ({
  schema: 'kortix.session/2', v: 1, message_id: 'message', thread_id: 'thread', seq: 1,
  role: 'user', kind: 'turn', status: 'complete', in_context: true, model: null,
  usage: null, finish: null, error: null, created_at: '2026-01-01T00:00:00Z',
  completed_at: null, producer: { harness: 'pi', harness_version: '1', adapter_version: '1' }, blocks,
});
const attachment: SessionLogMessage['blocks'][number] = {
  type: 'attachment', id: 'file', name: 'notes.txt', mime: 'text/plain', url: 'data:text/plain,notes',
};

test('MessageView renders a file-only user message', () => {
  const html = renderToStaticMarkup(<MessageView message={message([attachment])} />);
  expect(html).toContain('notes.txt');
  expect(html).toContain('data-message-role="user"');
});

test('MessageView keeps user markdown literal alongside attachments', () => {
  const html = renderToStaticMarkup(<MessageView message={message([
    { type: 'text', id: 'text', text: '**literal**' }, attachment,
  ])} />);
  expect(html).toContain('**literal**');
  expect(html).not.toContain('<strong>');
  expect(html).toContain('notes.txt');
});

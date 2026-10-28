import { SESSION_LOG_MINOR, SESSION_LOG_SCHEMA, sessionLogTurns, type SessionLogMessage } from '@kortix/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { TooltipProvider } from '../../primitives/tooltip';
import { IntlTestProvider } from '../../test-utils/intl';
import '../tool/tools/register';
import { SessionTurn } from './transcript';

const IMAGE = '/workspace/output/images/fox.png';

function message(id: string, role: 'user' | 'assistant', blocks: SessionLogMessage['blocks'], extra: Partial<SessionLogMessage> = {}): SessionLogMessage {
  return {
    schema: SESSION_LOG_SCHEMA, v: SESSION_LOG_MINOR, message_id: id, thread_id: 'synthetic', seq: 1,
    role, kind: 'turn', status: 'complete', in_context: true, model: null, usage: null,
    finish: null, error: null, created_at: '2026-01-01T00:00:00Z', completed_at: '2026-01-01T00:00:30Z',
    producer: { harness: 'pi', harness_version: '1', adapter_version: '1' }, blocks, ...extra,
  };
}

function call(id: string, name: string, input: Record<string, unknown>, output: string): SessionLogMessage['blocks'][number] {
  return {
    type: 'tool_call', id, call_id: id, name, kind: 'other', input, status: 'complete',
    result: { content: [{ type: 'text', text: output }], is_error: false },
    started_at: '2026-01-01T00:00:01Z', ended_at: '2026-01-01T00:00:20Z',
  };
}

// D5 through the real transcript: image_gen draws the image, the later `show`
// of the same file plus a PDF keeps only the PDF.
test('a turn with image_gen and a show of the same image draws the image once and keeps the PDF', () => {
  const turns = sessionLogTurns({
    schema: SESSION_LOG_SCHEMA, v: SESSION_LOG_MINOR, thread_id: 'synthetic', parent_thread_id: null, spawned_by: null,
    agent: null, title: null, created_at: '', messages: [
      message('prompt', 'user', [{ type: 'text', id: 'q', text: 'Draw a synthetic fox' }]),
      message('reply', 'assistant', [
        call('img-1', 'image_gen', { action: 'generate', prompt: 'A synthetic fox', size: '1536x1024' },
          JSON.stringify({ path: IMAGE, action: 'generate', size: '1536x1024', model: 'gpt-image-2' })),
        call('show-1', 'show', { items: [{ type: 'image', path: IMAGE }, { type: 'file', path: '/workspace/report.pdf', title: 'report.pdf' }] }, ''),
        { type: 'text', id: 'answer', text: 'Synthetic answer' },
      ], { reply_to: 'prompt' }),
    ],
  });
  const turn = turns[0];
  if (!turn) throw new Error('Missing synthetic turn');
  const html = renderToStaticMarkup(
    <IntlTestProvider locale="en" onError={() => {}}>
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <SessionTurn
            turn={turn} turnOutcome={{}} sessionId="synthetic" sessionStatus={undefined} isLast ownsPlan={false}
            permissions={[]} questions={[]} sessionWorking={false} isWorkingTurn={false}
            suppressBusyIndicator={false} awaitingUser={false} pending={false} isFirstTurn
            onPermissionReply={async () => {}} onRewind={() => {}} rewindDisabled
          />
        </TooltipProvider>
      </QueryClientProvider>
    </IntlTestProvider>,
  );
  // One image surface: the image_gen card's frame. The show draws no second one.
  expect(html.match(/<figure/g)).toHaveLength(1);
  expect(html.match(/Loading image/g)).toHaveLength(1);
  // The card carries no prompt caption (R29); the viewer shows it on open.
  expect(html).not.toContain('A synthetic fox');
  // The show keeps the PDF and names no image tab.
  expect(html).toContain('report.pdf');
  expect(html).not.toContain('>fox.png<');
});

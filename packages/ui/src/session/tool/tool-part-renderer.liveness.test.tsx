import './tools/register';
import { TurnLiveContext } from './shared/infrastructure';
import { toolCallBlock, type ToolCallBlock } from '@kortix/sdk';
import type { ToolPart } from '../../shared/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { IntlTestProvider } from '../../test-utils/intl';
import { renderToStaticMarkup } from 'react-dom/server';

import { ToolPartRenderer } from './tool-part-renderer';

// Synthetic calls; every id and value is invented.
const T0 = 1_790_000_000_000;
const part = (id: string, tool: string, state: Record<string, unknown>): ToolPart =>
  ({ id, sessionID: 'ses_cl01', messageID: 'msg_cl01', type: 'tool', callID: `call_${id}`, tool, state }) as unknown as ToolPart;
const OPEN = {
  bash: part('prt_bash', 'bash', { status: 'running', input: { command: 'sleep 60', description: 'Waits' }, title: 'Waits', metadata: { output: 'tick\n', description: 'Waits' }, time: { start: T0 } }),
  write: part('prt_write', 'write', { status: 'pending', input: {}, raw: '' }),
  read: part('prt_read', 'read', { status: 'running', input: { filePath: '/w/a.ts' }, time: { start: T0 + 5 } }),
  task: part('prt_task', 'task', { status: 'running', input: { description: 'sub', prompt: 'go', subagent_type: 'general' }, title: 'sub', metadata: { sessionId: 'ses_clchild' }, time: { start: T0 + 9 } }),
};

/** What the API's v2 page serves for an open call at rest: the closure rule (C2/F11). The residual stays. */
const closed = (call: ToolCallBlock): ToolCallBlock => ({
  ...call,
  status: 'error',
  result: {
    content: [{ type: 'text', text: '[Tool execution was interrupted]' }],
    is_error: true,
    synthetic: true,
    error: { code: 'interrupted', message: '[Tool execution was interrupted]' },
  },
});

const render = (call: ToolCallBlock, turnLive: boolean) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <IntlTestProvider locale="en" onError={() => {}}>
        <TurnLiveContext.Provider value={turnLive}>
          <ToolPartRenderer call={call} sessionId="s1" defaultOpen />
        </TurnLiveContext.Provider>
      </IntlTestProvider>
    </QueryClientProvider>,
  );

/**
 * The liveness rule is the SDK's (`sessionLogCallStatus`, `sessionLogOpenCall`, tested in
 * packages/sdk). This pins what the renderer draws with it: a dead open call on the v1 live
 * view and its closure-rule block on the v2 page at rest are one DOM, on a live turn and after it.
 */
describe('one rendering for a dead open call: the v1 live view and the v2 page at rest', () => {
  for (const [name, p] of Object.entries(OPEN)) {
    for (const turnLive of [false, true]) {
      test(`${name}, turn ${turnLive ? 'live' : 'over'}: the same DOM`, () => {
        const live = render(toolCallBlock(p), turnLive);
        expect(live.length).toBeGreaterThan(0);
        expect(render(closed(toolCallBlock(p)), turnLive)).toBe(live);
      });
    }
  }
});

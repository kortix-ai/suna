import { sessionLogOfV1Rows } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SessionTrajectory, trajectoryText } from './session-trajectory';

describe('session trajectory', () => {
  test('empty history has a clear empty state', () => {
    expect(renderToStaticMarkup(<SessionTrajectory messages={[]} />)).toContain('No activity yet');
  });
  test('lists canonical messages in order with status and context', () => {
    const log = sessionLogOfV1Rows('demo', 'root', [
      {
        info: { id: 'prompt', role: 'user', time: { created: 1700000000000 } },
        parts: [{ type: 'text', text: 'Inspect fixture' }],
      },
      {
        info: { id: 'reply', role: 'assistant', time: { created: 1700000001000 } },
        parts: [{ type: 'text', text: 'Done' }],
      },
    ] as never);
    const messages = log.threads[0]?.messages ?? [];
    const html = renderToStaticMarkup(<SessionTrajectory messages={messages} />);
    expect(html.indexOf('user')).toBeLessThan(html.indexOf('assistant'));
    expect(html).toContain('Trajectory');
    expect(html).toContain('complete');
  });
  test('tool inspection preserves inputs, outputs and semantic errors', () => {
    expect(
      trajectoryText({
        id: 'tool',
        type: 'tool_call',
        call_id: 'call',
        name: 'read',
        kind: 'read',
        input: { path: 'fixture.txt' },
        status: 'complete',
        result: {
          content: [{ type: 'text', text: 'missing fixture' }],
          is_error: true,
          error: { message: 'Not found' },
        },
      }),
    ).toContain('fixture.txt');
    expect(
      trajectoryText({
        id: 'tool',
        type: 'tool_call',
        call_id: 'call',
        name: 'read',
        kind: 'read',
        input: {},
        status: 'error',
        result: {
          content: [{ type: 'text', text: 'missing fixture' }],
          is_error: true,
          error: { message: 'Not found' },
        },
      }),
    ).toContain('Not found');
    expect(trajectoryText({ id: 'reason', type: 'reasoning', text: 'Check the fixture' })).toBe(
      'Check the fixture',
    );
    expect(
      trajectoryText({
        id: 'compact',
        type: 'compaction',
        summary: null,
        first_kept_message_id: null,
      }),
    ).toBe('Encrypted summary');
  });
});

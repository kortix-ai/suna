import { describe, expect, test } from 'bun:test';

import type { AcpTranscriptMessage } from '@kortix/sdk/acp/transcript';
import { deriveAcpActivity } from '../commands/sessions-chat.ts';

function message(
  role: AcpTranscriptMessage['role'],
  created: string,
  options: { text?: string; tool?: { name: string; status: string } } = {},
): AcpTranscriptMessage {
  return {
    role,
    created,
    completed: null,
    text: options.text ?? '',
    tools: options.tool
      ? [{ tool: options.tool.name, status: options.tool.status }]
      : [],
    files: [],
    reasoning_omitted: false,
    error: null,
  };
}

describe('deriveAcpActivity', () => {
  test('reports a running tool from the recent ACP transcript window', () => {
    const messages = [
      message('assistant', '2026-07-23T00:00:01.000Z', {
        tool: { name: 'task', status: 'running' },
      }),
      message('user', '2026-07-23T00:00:02.000Z', { text: 'subagent prompt' }),
    ];

    const activity = deriveAcpActivity(messages, 'running');

    expect(activity.working).toBe(true);
    expect(activity.summary).toBe('running task…');
  });

  test('reports a fresh user prompt as queued when no tool is running', () => {
    const activity = deriveAcpActivity([
      message('user', '2026-07-23T00:00:01.000Z', { text: 'do the thing' }),
    ], 'running');

    expect(activity.working).toBe(true);
    expect(activity.summary).toBe('queued — agent picking up…');
  });

  test('reports the latest assistant text when the recent window is idle', () => {
    const activity = deriveAcpActivity([
      message('user', '2026-07-23T00:00:01.000Z', { text: 'do the thing' }),
      message('assistant', '2026-07-23T00:00:02.000Z', { text: 'all done' }),
    ], 'running');

    expect(activity.working).toBe(false);
    expect(activity.summary).toBe('all done');
  });

  test('reports lifecycle states before transcript activity', () => {
    expect(deriveAcpActivity([], 'provisioning').summary).toBe('provisioning…');
    expect(deriveAcpActivity([], 'branching').summary).toBe('provisioning…');
    expect(deriveAcpActivity([], 'queued').summary).toBe('booting…');
  });
});

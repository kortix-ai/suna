import { describe, expect, test } from 'bun:test';
import { projectSessionMessageHref } from './session-href';

describe('projectSessionMessageHref', () => {
  test('names the sub-thread, the message and the instant', () => {
    expect(projectSessionMessageHref('p1', 's1', { threadId: 'ses_pi0a', messageId: 'msg_1', at: 1_700_000_000_123.7 })).toBe(
      '/workspaces/p1/sessions/s1?rs=ses_pi0a&m=msg_1&at=1700000000123',
    );
  });

  test('leaves out the parts the target does not name', () => {
    expect(projectSessionMessageHref('p1', 's1', { messageId: null, at: 42 })).toBe('/workspaces/p1/sessions/s1?at=42');
    expect(projectSessionMessageHref('p1', 's1', {})).toBe('/workspaces/p1/sessions/s1');
    expect(projectSessionMessageHref('p1', 's1', { at: Number.NaN })).toBe('/workspaces/p1/sessions/s1');
  });
});

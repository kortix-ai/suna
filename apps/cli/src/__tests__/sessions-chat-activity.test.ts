// deriveActivity turns a session's recent messages + Kortix status into a "what's
// it doing" label. The regression these tests guard: a RUNNING session that is
// actively mid-turn (an in-flight assistant turn, or a running tool from a just-
// dispatched subagent batch) must NOT be labelled "queued — agent picking up…".
import { describe, expect, test } from 'bun:test';

import type { OpencodeMessageWithParts } from '../api/sandbox-proxy.ts';
import { deriveActivity } from '../commands/sessions-chat.ts';

function userMsg(created: number, text = 'do the thing'): OpencodeMessageWithParts {
  return {
    info: { id: `u-${created}`, role: 'user', sessionID: 's', time: { created } },
    parts: [{ type: 'text', text }],
  };
}
function assistantMsg(
  created: number,
  opts: { completed?: number; tool?: { name: string; status: string }; text?: string } = {},
): OpencodeMessageWithParts {
  const parts: OpencodeMessageWithParts['parts'] = [];
  if (opts.tool) parts.push({ type: 'tool', tool: opts.tool.name, state: { status: opts.tool.status } });
  if (opts.text) parts.push({ type: 'text', text: opts.text });
  return {
    info: {
      id: `a-${created}`,
      role: 'assistant',
      sessionID: 's',
      time: { created, ...(opts.completed ? { completed: opts.completed } : {}) },
    },
    parts,
  };
}

describe('deriveActivity', () => {
  test('running + a running tool anywhere in the window → not "queued"', () => {
    // Assistant dispatched a subagent (running `task` tool), and a subagent
    // user-role prompt is newest — the pre-fix code read this as "queued".
    const msgs = [
      assistantMsg(1, { tool: { name: 'task', status: 'running' } }),
      userMsg(2, 'subagent prompt'),
    ];
    const a = deriveActivity(msgs, 'running');
    expect(a.working).toBe(true);
    expect(a.summary).toBe('running task…');
    expect(a.summary).not.toContain('queued');
  });

  test('running + an in-flight (uncompleted) assistant turn → "working…", not "queued"', () => {
    const msgs = [assistantMsg(1, {}), userMsg(2)];
    const a = deriveActivity(msgs, 'running');
    expect(a.working).toBe(true);
    expect(a.summary).toBe('working…');
  });

  test('running + only a fresh user prompt, no assistant activity → stays "queued"', () => {
    const a = deriveActivity([userMsg(1)], 'running');
    expect(a.working).toBe(true);
    expect(a.summary).toBe('queued — agent picking up…');
  });

  test('running + a completed assistant reply → idle summary of the reply text', () => {
    const a = deriveActivity([userMsg(1), assistantMsg(2, { completed: 3, text: 'all done' })], 'running');
    expect(a.working).toBe(false);
    expect(a.summary).toBe('all done');
  });

  test('non-running lifecycle states describe the box, not a turn', () => {
    expect(deriveActivity([], 'provisioning').summary).toBe('provisioning…');
    expect(deriveActivity([], 'branching').summary).toBe('provisioning…');
    expect(deriveActivity([], 'queued').summary).toBe('booting…');
  });
});

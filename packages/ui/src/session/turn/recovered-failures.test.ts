import { describe, expect, test } from 'bun:test';
import type { ToolCallBlock } from '@kortix/sdk';
import { recoveredShellFailures } from './recovered-failures';

// KRTX-3021: the first thing a person saw in a new project was a red "Command
// failed": the agent's `ls` probe of a folder that did not exist yet. The
// agent moved on and the turn finished. A failure the agent moved past keeps
// its verdict, in the muted ink; red stays for the failure the turn ended on.
let n = 0;
function bash(exit: number | null, status: ToolCallBlock['status'] = 'complete'): ToolCallBlock {
  n += 1;
  return {
    id: `blk_${n}`,
    type: 'tool_call',
    call_id: `call_${n}`,
    name: 'bash',
    kind: 'shell',
    input: { command: 'ls' },
    status,
    result: { content: [{ type: 'text', text: 'out' }], is_error: false, ...(exit === null ? {} : { exit_code: exit }) },
  };
}
const read = (status: ToolCallBlock['status'] = 'complete'): ToolCallBlock => ({
  ...bash(null, status),
  name: 'read',
  kind: 'read',
});

describe('recoveredShellFailures', () => {
  test('a failed command followed by a step that worked is recovered', () => {
    const probe = bash(2);
    const next = read();
    expect(recoveredShellFailures([probe, next])).toEqual(new Set([probe.id]));
  });

  test('the failure the turn ended on is not recovered', () => {
    const probe = bash(2);
    expect(recoveredShellFailures([read(), probe]).size).toBe(0);
  });

  test('only failures count, and another failure after it is no recovery', () => {
    const ok = bash(0);
    const first = bash(1);
    const second = bash(1);
    expect(recoveredShellFailures([ok, first, second])).toEqual(new Set());
    const after = read();
    expect(recoveredShellFailures([ok, first, second, after])).toEqual(new Set([first.id, second.id]));
  });

  test('a tagged exit code counts the same as a recorded one', () => {
    const tagged: ToolCallBlock = {
      ...bash(null),
      result: { content: [{ type: 'text', text: 'FAIL\n<exit_code>1</exit_code>' }], is_error: false },
    };
    const next = read();
    expect(recoveredShellFailures([tagged, next])).toEqual(new Set([tagged.id]));
  });

  test('a step that errored is no recovery', () => {
    const probe = bash(2);
    expect(recoveredShellFailures([probe, read('error')]).size).toBe(0);
  });
});

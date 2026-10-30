import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeShellExit } from './shell-exit';
import type { SessionLogPage } from './source';
import { EMPTY_SESSION_LOG_STATE, applySessionLogPage, selectSessionLogThread } from './store';
import { toolCallError, toolCallMetadata, toolCallRawOutput, toolCallStatus } from './tool-call';
import type { SessionLog, ToolCallBlock } from './types';

// KRTX-3021: on the pi harness, `ls -la /workspace/research` in a new project
// (no such directory) came back as a failed tool call, `status: 'error'`, its
// output plus "Command exited with code 2". The transcript drew it as a tool
// error. OpenCode reports the same command as completed, with the exit code.
const OUTPUT = 'total 52\ndrwxr-xr-x 7 user user 4096 .\n---RESEARCH---\n';

function piBash(over: Partial<ToolCallBlock> = {}): ToolCallBlock {
  const text = `${OUTPUT}\n\nCommand exited with code 2`;
  return {
    id: 'blk_bash_1',
    type: 'tool_call',
    call_id: 'call_bash_1',
    name: 'bash',
    kind: 'shell',
    input: { command: 'ls -la /workspace && ls -la /workspace/research' },
    status: 'error',
    result: { content: [{ type: 'text', text }], is_error: true, error: { message: text } },
    started_at: '2026-10-21T11:04:07.315Z',
    ended_at: '2026-10-21T11:04:07.347Z',
    ...over,
  };
}

describe('a shell command that exited non-zero', () => {
  test('reads as a completed command with its output and exit code', () => {
    const call = normalizeShellExit(piBash());
    expect(call.status).toBe('complete');
    expect(toolCallStatus(call)).toBe('completed');
    expect(toolCallError(call)).toBeUndefined();
    expect(toolCallRawOutput(call)).toBe(OUTPUT);
    expect(toolCallMetadata(call).exit).toBe(2);
    expect(call.result?.is_error).toBe(false);
    expect(call.result?.error).toBeUndefined();
  });

  test('a failed call with no exit line keeps its error: the command did not finish', () => {
    const timedOut = piBash({
      result: { content: [{ type: 'text', text: 'Command timed out after 120s' }], is_error: true, error: { message: 'Command timed out after 120s' } },
    });
    expect(normalizeShellExit(timedOut)).toBe(timedOut);
  });

  test('another tool, and a completed command, are returned as they are', () => {
    const read = piBash({ name: 'read', kind: 'read' });
    expect(normalizeShellExit(read)).toBe(read);
    const done = piBash({ status: 'complete', result: { content: [{ type: 'text', text: 'ok' }], is_error: false } });
    expect(normalizeShellExit(done)).toBe(done);
  });
});

describe('the session-log store', () => {
  test('stores a pi command that exited non-zero as a completed command', () => {
    const log: SessionLog = JSON.parse(
      readFileSync(join(import.meta.dir, '../../../../api-contract/src/__tests__/fixtures/session-log/golden21.v2.json'), 'utf8'),
    );
    const { threads, ...session } = structuredClone(log);
    const messages = structuredClone(threads[0]!.messages);
    const assistant = messages.find((m) => m.role === 'assistant')!;
    assistant.blocks = [...assistant.blocks, piBash()];
    const page: SessionLogPage = {
      session,
      generation: 1,
      threads: threads.map(({ messages: _m, ...head }) => head),
      thread_id: threads[0]!.thread_id,
      messages,
      has_more: false,
    };
    const thread = selectSessionLogThread(applySessionLogPage(EMPTY_SESSION_LOG_STATE, page), threads[0]!.thread_id);
    const stored = thread!.messages
      .flatMap((m) => m.blocks)
      .find((b): b is ToolCallBlock => b.type === 'tool_call' && b.id === 'blk_bash_1');
    expect(stored?.status).toBe('complete');
    expect(toolCallMetadata(stored!).exit).toBe(2);
  });
});

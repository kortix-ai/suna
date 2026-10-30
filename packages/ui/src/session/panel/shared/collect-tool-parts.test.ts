import type { ToolPart } from '../../../internal/session-types';
import { toolCallBlock, type SessionLogMessage, type ToolCallBlock } from '@kortix/sdk';
import { describe, expect, it } from 'bun:test';
import { collectAllToolCalls, collectToolCalls } from './collect-tool-parts';

function call(
  tool: string,
  status: 'pending' | 'running' | 'completed' | 'error' = 'completed',
): ToolCallBlock {
  return toolCallBlock({
    type: 'tool',
    tool,
    callID: `c-${tool}-${Math.random()}`,
    state: { status, input: {}, ...(status === 'running' && { time: { start: 1 } }) },
  } as unknown as ToolPart);
}

function messages(blocks: ToolCallBlock[], extra: Partial<SessionLogMessage> = {}): SessionLogMessage[] {
  return [{ role: 'assistant', kind: 'turn', in_context: true, blocks, ...extra } as SessionLogMessage];
}

/** What the API's v2 page serves for a call that never finished: the closure rule. */
const closed = (c: ToolCallBlock): ToolCallBlock => ({
  ...c,
  status: 'error',
  result: { content: [], is_error: true, synthetic: true, error: { code: 'interrupted', message: '' } },
});

describe('collectAllToolCalls (Easy mode)', () => {
  it('retains read calls — Advanced hides them, Easy mode narrates "Read N files"', () => {
    const calls = collectAllToolCalls(messages([call('read'), call('read'), call('read')]));
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.name === 'read')).toBe(true);
  });

  it('retains a skill call — Advanced hides it in favor of the side sheet', () => {
    const calls = collectAllToolCalls(messages([call('skill')]));
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('skill');
  });

  it('still excludes todoread — a universal rule, not an actions-panel-only one', () => {
    const calls = collectAllToolCalls(messages([call('read'), call('todoread')]));
    expect(calls.map((c) => c.name)).toEqual(['read']);
  });

  it('reads only tool_call blocks, from every message in or out of context', () => {
    const c = call('bash');
    const log: SessionLogMessage[] = [
      { role: 'user', kind: 'turn', in_context: true, blocks: [{ type: 'text', id: 't', text: 'hi' }] } as SessionLogMessage,
      ...messages([c], { in_context: false, hidden_reason: 'failed_attempt' }),
    ];
    expect(collectAllToolCalls(log)).toEqual([c]);
    expect(collectAllToolCalls(undefined)).toEqual([]);
  });

  it('reads a call the page closed at rest as the open call the live view holds', () => {
    const running = call('bash', 'running');
    const [seen] = collectAllToolCalls(messages([closed(running)]));
    expect(seen.status).toBe('running');
    expect(seen.result).toBeUndefined();
    // A real error stays an error.
    expect(collectAllToolCalls(messages([call('bash', 'error')]))[0].status).toBe('error');
  });
});

describe('collectToolCalls (Advanced)', () => {
  it('drops read and skill calls, keeps the rest in order', () => {
    const calls = collectToolCalls(messages([call('read'), call('bash'), call('skill'), call('write')]));
    expect(calls.map((c) => c.name)).toEqual(['bash', 'write']);
  });

  it('drops the memory lookup tools', () => {
    const calls = collectToolCalls(messages([call('memory_search'), call('bash')]));
    expect(calls.map((c) => c.name)).toEqual(['bash']);
  });
});

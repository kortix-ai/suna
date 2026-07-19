import { describe, expect, test } from 'bun:test';

import { emptyReducerState, reduceEnvelope } from './reduce';
import { acpToolCallToPart } from './tool-part';
import type { AcpStoredEnvelope, AcpToolCall } from './transcript';

/**
 * Pins the daemon's synthetic "output discovery" envelope (Task 2 of the
 * universal-outputs plan, `335d94110`): when the sandbox agent notices new
 * files it hasn't reported yet, it emits a fabricated `session/update`
 * `tool_call` — no real ACP tool call ever happened — with `tool: 'show'`
 * and `_meta.kortix.synthetic: 'filesystem-delta'`. Every host renders this
 * through the SAME reducer + `acpToolCallToPart` normalization as any other
 * tool call, so this locks that the existing, generic normalization already
 * produces the shape the daemon feature depends on: no provider branch, no
 * synthetic-specific code path anywhere in the SDK.
 */
function stored(ordinal: number, envelope: AcpStoredEnvelope['envelope']): AcpStoredEnvelope {
  return { ordinal, direction: 'agent_to_client', envelope };
}

const SYNTHETIC_SHOW_ENVELOPE = {
  jsonrpc: '2.0',
  method: 'session/update',
  params: {
    sessionId: 'sess-1',
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'kortix-outputs:1',
      title: 'Show',
      kind: 'other',
      status: 'completed',
      tool: 'show',
      rawInput: { items: [{ path: '/workspace/report.pdf' }, { path: '/workspace/data.csv' }] },
      _meta: { kortix: { synthetic: 'filesystem-delta', schemaVersion: 1, truncated: false } },
    },
  },
} as const;

describe('synthetic output-show envelope', () => {
  test('reduces to a tool item and normalizes to tool "show" with pinned metadata', () => {
    const row = stored(1, SYNTHETIC_SHOW_ENVELOPE);
    const state = reduceEnvelope(emptyReducerState(), row);

    const toolItem = state.chatItems.find((item) => item.kind === 'tool');
    expect(toolItem).toBeDefined();
    expect(toolItem?.kind).toBe('tool');
    const toolCall = toolItem as Extract<typeof toolItem, { kind: 'tool' }> & AcpToolCall;

    const part = acpToolCallToPart(toolCall);

    expect(part.tool).toBe('show');
    expect(part.state.status).toBe('completed');
    expect(part.state.input.items).toEqual([
      { path: '/workspace/report.pdf' },
      { path: '/workspace/data.csv' },
    ]);
    expect((part.state.metadata.acp as any)._meta.kortix.synthetic).toBe('filesystem-delta');
  });
});

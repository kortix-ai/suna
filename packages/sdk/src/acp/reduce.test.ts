import { describe, expect, test } from 'bun:test';

import fixtureRows from './__fixtures__/acp-session-mixed.json';
import { emptyReducerState, pendingFromState, reduceEnvelope } from './reduce';
import {
  projectAcpChatItems,
  projectAcpPendingPrompts,
  projectAcpTurnState,
  projectAcpUsage,
  type AcpStoredEnvelope,
} from './transcript';

const rows = fixtureRows as unknown as AcpStoredEnvelope[];

function stored(
  ordinal: number,
  direction: AcpStoredEnvelope['direction'],
  envelope: AcpStoredEnvelope['envelope'],
  streamEventId?: number | null,
): AcpStoredEnvelope {
  return { ordinal, direction, envelope, ...(streamEventId !== undefined ? { streamEventId } : {}) };
}

function userPrompt(ordinal: number, text = 'hi', id: number | string = ordinal, sessionId?: string): AcpStoredEnvelope {
  return stored(ordinal, 'client_to_agent', {
    jsonrpc: '2.0', id, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text }] },
  });
}

function cancelNotification(ordinal: number, sessionId?: string): AcpStoredEnvelope {
  return stored(ordinal, 'client_to_agent', {
    jsonrpc: '2.0', method: 'session/cancel', params: { sessionId },
  });
}

function agentChunk(ordinal: number, text: string): AcpStoredEnvelope {
  return stored(ordinal, 'agent_to_client', {
    jsonrpc: '2.0', method: 'session/update',
    params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
  });
}

describe('reduceEnvelope', () => {
  test('incremental reduce matches from-scratch projection on a recorded session', () => {
    let state = emptyReducerState();
    for (const row of rows) state = reduceEnvelope(state, row);

    expect(state.chatItems).toEqual(projectAcpChatItems(rows));
    expect(pendingFromState(state)).toEqual(projectAcpPendingPrompts(rows));
    expect(state.usage).toEqual(projectAcpUsage(rows));
    expect(state.turnState).toEqual(projectAcpTurnState(rows));
    // The fixture has no duplicate (direction, streamEventId) pairs, so every
    // row — including inert ones that change no projection — must extend the
    // envelope log. `envelopes` is the documented source-of-truth log
    // (`snapshot.envelopes`); silently dropping a non-duplicate row from it
    // is a correctness bug, not an optimization.
    expect(state.envelopes.length).toBe(rows.length);
  });

  test('an inert row that changes no projection still extends the envelope log', () => {
    // A persisted `client_to_agent` row for a method the reducer's chat-item
    // branches don't recognize (e.g. `session/cancel`), arriving with
    // `streamEventId: null` as `client.transcript()` rows do. It changes no
    // projection (no chat item, no usage, no turn state, no pending
    // request) but MUST still be appended to `envelopes` — the pre-task
    // reducer appended every non-duplicate row unconditionally.
    const inert: AcpStoredEnvelope = {
      ordinal: rows.length + 1,
      direction: 'client_to_agent',
      streamEventId: null,
      envelope: { jsonrpc: '2.0', id: 77, method: 'session/cancel', params: {} },
    };

    let state = emptyReducerState();
    for (const row of rows) state = reduceEnvelope(state, row);
    const beforeInert = state;
    state = reduceEnvelope(state, inert);

    expect(state.envelopes.length).toBe(rows.length + 1);
    expect(state.envelopes).toEqual([...beforeInert.envelopes, inert]);
    expect(state.envelopes).toContainEqual(inert);
  });

  test('a message chunk gives new identity only to the tail item', () => {
    let state = emptyReducerState();
    state = reduceEnvelope(state, userPrompt(1));
    state = reduceEnvelope(state, agentChunk(2, 'hel'));
    const before = state.chatItems;
    state = reduceEnvelope(state, agentChunk(3, 'lo'));

    expect(state.chatItems[0]).toBe(before[0]);
    expect(state.chatItems[1]).not.toBe(before[1]);
    expect((state.chatItems[1] as { text: string }).text).toBe('hello');
  });

  test('tool_call_update before tool_call still produces one tool item', () => {
    let state = emptyReducerState();
    state = reduceEnvelope(state, stored(1, 'agent_to_client', {
      jsonrpc: '2.0', method: 'session/update',
      params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-x', status: 'in_progress' } },
    }));
    state = reduceEnvelope(state, stored(2, 'agent_to_client', {
      jsonrpc: '2.0', method: 'session/update',
      params: { update: { sessionUpdate: 'tool_call', toolCallId: 'call-x', title: 'Grep', kind: 'search', rawInput: { pattern: 'foo' } } },
    }));

    expect(state.chatItems).toHaveLength(1);
    expect(state.chatItems[0]).toEqual(expect.objectContaining({
      kind: 'tool',
      id: 'call-x',
      title: 'Grep',
      toolKind: 'search',
      status: 'in_progress',
      rawInput: { pattern: 'foo' },
    }));
  });

  test('ordinal backstop: a NEW request reusing an old, already-answered numeric id stays pending', () => {
    // Old persisted logs used small numeric JSON-RPC ids, so the same id
    // value can legitimately be reused by an unrelated LATER request once
    // an earlier request/response pair with that id has already completed.
    // A response only answers the request it was ordinally paired with —
    // it must never permanently "poison" that id key for every future
    // request that happens to reuse it.
    let state = emptyReducerState();
    // Request id 3 (ordinal 10): a permission request.
    state = reduceEnvelope(state, stored(10, 'agent_to_client', {
      jsonrpc: '2.0', id: 3, method: 'session/request_permission',
      params: { sessionId: 's1', options: [{ optionId: 'allow', label: 'Allow' }] },
    }));
    expect(pendingFromState(state).permissions).toHaveLength(1);

    // Response id 3 (ordinal 11): answers it.
    state = reduceEnvelope(state, stored(11, 'client_to_agent', {
      jsonrpc: '2.0', id: 3, result: { outcome: { outcome: 'selected', optionId: 'allow' } },
    }));
    expect(pendingFromState(state).permissions).toHaveLength(0);

    // NEW, unrelated request id 3 (ordinal 20): must stay pending — the old
    // answered-set must not gate reopening a reused id.
    state = reduceEnvelope(state, stored(20, 'agent_to_client', {
      jsonrpc: '2.0', id: 3, method: 'session/request_permission',
      params: { sessionId: 's1', options: [{ optionId: 'allow', label: 'Allow' }] },
    }));
    expect(pendingFromState(state).permissions).toHaveLength(1);
  });

  test('ordinal backstop: a NEW prompt reusing an old, already-answered numeric id stays pending (turnState.busy)', () => {
    let state = emptyReducerState();
    // Prompt id 5 (ordinal 10), answered at ordinal 11.
    state = reduceEnvelope(state, userPrompt(10, 'first', 5));
    expect(state.turnState.busy).toBe(true);
    state = reduceEnvelope(state, stored(11, 'agent_to_client', {
      jsonrpc: '2.0', id: 5, result: { stopReason: 'end_turn' },
    }));
    expect(state.turnState.busy).toBe(false);

    // NEW prompt reusing id 5 (ordinal 20): must be busy again.
    state = reduceEnvelope(state, userPrompt(20, 'second', 5));
    expect(state.turnState.busy).toBe(true);
    expect(state.turnState.pendingPromptIds).toEqual([5]);
  });

  test('a duplicate streamEventId row is dropped', () => {
    let state = emptyReducerState();
    const first = stored(1, 'agent_to_client', {
      jsonrpc: '2.0', method: 'session/update',
      params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } },
    }, 7);
    state = reduceEnvelope(state, first);
    const afterFirst = state;

    const duplicate = stored(2, 'agent_to_client', {
      jsonrpc: '2.0', method: 'session/update',
      params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'again' } } },
    }, 7);
    state = reduceEnvelope(state, duplicate);

    expect(state).toBe(afterFirst);
    expect(state.chatItems).toHaveLength(1);
    expect((state.chatItems[0] as { text: string }).text).toBe('hi');
  });

  describe('busy-staleness policy', () => {
    test('a session/cancel row clears every open prompt for the same session', () => {
      let state = emptyReducerState();
      state = reduceEnvelope(state, userPrompt(1, 'go', 'req-1', 's1'));
      expect(state.turnState).toEqual({ busy: true, pendingPromptIds: ['req-1'] });

      state = reduceEnvelope(state, cancelNotification(2, 's1'));
      expect(state.turnState).toEqual({ busy: false, pendingPromptIds: [] });
    });

    test('a session/cancel row for a different session leaves the pending prompt open', () => {
      let state = emptyReducerState();
      state = reduceEnvelope(state, userPrompt(1, 'go', 'req-1', 's1'));
      state = reduceEnvelope(state, cancelNotification(2, 's2'));
      expect(state.turnState).toEqual({ busy: true, pendingPromptIds: ['req-1'] });
    });

    test('a newer session/prompt supersedes an earlier orphaned prompt, keeping only itself pending', () => {
      let state = emptyReducerState();
      state = reduceEnvelope(state, userPrompt(1, 'first', 'req-1', 's1'));
      state = reduceEnvelope(state, userPrompt(3, 'second', 'req-2', 's1'));
      expect(state.turnState).toEqual({ busy: true, pendingPromptIds: ['req-2'] });
    });

    test('a local optimistic prompt echo (send()) also supersedes an earlier orphaned prompt', () => {
      // `AcpSession.send()` posts its optimistic echo with a `local-`
      // prefixed id, which never itself becomes a tracked pending prompt —
      // but it still must clear a stale orphan from an earlier reload so a
      // fresh send() is never permanently blocked behind it.
      let state = emptyReducerState();
      state = reduceEnvelope(state, userPrompt(1, 'orphaned', 'req-1', 's1'));
      expect(state.turnState.busy).toBe(true);

      state = reduceEnvelope(state, userPrompt(3, 'fresh', 'local-99', 's1'));
      expect(state.turnState).toEqual({ busy: false, pendingPromptIds: [] });
    });
  });
});

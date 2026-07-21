import { describe, expect, test } from 'bun:test';

import fixtureRows from './__fixtures__/acp-session-mixed.json';
import { clearOpenPrompts, emptyReducerState, pendingFromState, reduceEnvelope } from './reduce';
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

  // WS3-P2-a, part 2: pins for the guarded numeric-id machinery
  // (`openRequestOrdinals`/`openPromptOrdinals` + the ordinal-comparison
  // backstop, as opposed to the Map's mere existence, which the two tests
  // above already cover via same-order id reuse). These two prove the
  // comparison itself — not just the map — is load-bearing: they feed a row
  // whose ordinal is SMALLER than the currently-open entry's, the one shape
  // an in-order id-reuse fixture can never produce. `AcpSession.applyBatch`
  // documents this exact possibility as real (`session.ts` — "a live SSE
  // event can in principle reach `enqueue()` before a concurrently in-flight
  // history fetch resolves", `row.ordinal < cursor` fallback) and it is
  // reachable directly by ANY external caller of `reduceEnvelope`/
  // `project*`, which accept a caller-supplied `rows` array with no runtime
  // enforcement of ordinal order. Removing the `< row.ordinal` comparison
  // (keeping only `openRequests.has(key)`) would make both of these fail.
  test('ordinal backstop: a response delivered OUT OF ORDER (smaller ordinal than the open entry) does not close it', () => {
    let state = emptyReducerState();
    // Request id 3 opens at ordinal 20 (still pending).
    state = reduceEnvelope(state, stored(20, 'agent_to_client', {
      jsonrpc: '2.0', id: 3, method: 'session/request_permission',
      params: { sessionId: 's1', options: [{ optionId: 'allow', label: 'Allow' }] },
    }));
    expect(pendingFromState(state).permissions).toHaveLength(1);

    // A response for id 3 arrives with a SMALLER ordinal (11) than the
    // currently-open entry (20) — e.g. a stale/duplicate response row
    // (DISC-05/Pin-2: non-streaming agent_to_client replies also carry a
    // null `streamEventId` and are not DB-deduped) replayed after a later
    // reopen, or rows fed out of order to a raw fold. Without the ordinal
    // comparison this would incorrectly close the still-pending ordinal-20
    // request.
    state = reduceEnvelope(state, stored(11, 'client_to_agent', {
      jsonrpc: '2.0', id: 3, result: { outcome: { outcome: 'selected', optionId: 'allow' } },
    }));
    expect(pendingFromState(state).permissions).toHaveLength(1);
  });

  test('ordinal backstop: a prompt response delivered OUT OF ORDER does not clear turnState.busy', () => {
    let state = emptyReducerState();
    // Prompt id 5 opens at ordinal 20 (still pending/busy).
    state = reduceEnvelope(state, userPrompt(20, 'go', 5));
    expect(state.turnState.busy).toBe(true);

    // A response for id 5 arrives with a SMALLER ordinal (11) than the
    // currently-open entry (20).
    state = reduceEnvelope(state, stored(11, 'agent_to_client', {
      jsonrpc: '2.0', id: 5, result: { stopReason: 'end_turn' },
    }));
    expect(state.turnState.busy).toBe(true);
    expect(state.turnState.pendingPromptIds).toEqual([5]);
  });

  // WS3-P2-a, part 3: DISC-05 pin. P1-b proved the durable log can contain
  // DUPLICATE client_to_agent rows (null streamEventId, distinct ordinals)
  // from a retried POST — the (direction, streamEventId) dedupe key at the
  // top of `reduceEnvelope` only fires when `streamEventId != null`, so a
  // null-streamEventId duplicate is NEVER deduped by that check. This pins
  // — does not change — what the reducer does with such a duplicate today.
  test('DISC-05: a retried session/prompt (duplicate, null streamEventId, distinct ordinals) renders as TWO user messages — pinned, not fixed here', () => {
    const text = 'retried prompt';
    const first = stored(1, 'client_to_agent', {
      jsonrpc: '2.0', id: 'req-dup', method: 'session/prompt',
      params: { prompt: [{ type: 'text', text }] },
    }, null);
    const retried = stored(2, 'client_to_agent', {
      jsonrpc: '2.0', id: 'req-dup', method: 'session/prompt',
      params: { prompt: [{ type: 'text', text }] },
    }, null);

    let state = emptyReducerState();
    state = reduceEnvelope(state, first);
    state = reduceEnvelope(state, retried);

    const userMessages = state.chatItems.filter((item) => item.kind === 'message' && item.role === 'user');
    // PINNED: two durable rows -> two rendered chat items. A retried POST is
    // a user-visible duplicated message today. This is the UX-impact
    // statement DISC-05's schema decision needs; do not "fix" it here.
    expect(userMessages).toHaveLength(2);
    expect(userMessages.map((item) => (item as { text: string }).text)).toEqual([text, text]);

    // `projectAcpChatItems` (the fold-from-scratch selector every direct
    // caller and `AcpSession` share) reduces over the exact same
    // `reduceEnvelope`, so it must agree with the incremental fold above.
    const projected = projectAcpChatItems([first, retried]);
    expect(projected.filter((item) => item.kind === 'message' && item.role === 'user')).toHaveLength(2);
    expect(projected).toEqual(state.chatItems);
  });

  test('session/load history replay stays in the raw envelope log but does not create duplicate chat turns', () => {
    const originalPrompt = userPrompt(1, 'hello', 'prompt-1', 'session-1');
    const originalReply = agentChunk(2, 'original reply');
    const originalEnd = stored(3, 'agent_to_client', {
      jsonrpc: '2.0', id: 'prompt-1', result: { stopReason: 'end_turn' },
    });
    const load = stored(4, 'client_to_agent', {
      jsonrpc: '2.0', id: 'load-1', method: 'session/load',
      params: { sessionId: 'session-1', cwd: '/workspace' },
    });
    const replayedPrompt = stored(5, 'agent_to_client', {
      jsonrpc: '2.0', method: 'session/update',
      params: {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'hello' },
        },
      },
    });
    const replayedReply = agentChunk(6, 'original reply');
    const loadResult = stored(7, 'agent_to_client', {
      jsonrpc: '2.0', id: 'load-1', result: { sessionId: 'session-1' },
    });
    const nextPrompt = userPrompt(8, 'next question', 'prompt-2', 'session-1');
    const nextReply = agentChunk(9, 'fresh reply');
    const fixture = [
      originalPrompt,
      originalReply,
      originalEnd,
      load,
      replayedPrompt,
      replayedReply,
      loadResult,
      nextPrompt,
      nextReply,
    ];

    let state = emptyReducerState();
    for (const row of fixture) state = reduceEnvelope(state, row);

    expect(state.envelopes).toEqual(fixture);
    expect(state.chatItems).toEqual([
      { kind: 'message', id: 'prompt-1', role: 'user', text: 'hello' },
      { kind: 'message', id: 'assistant-2', role: 'assistant', text: 'original reply' },
      { kind: 'message', id: 'prompt-8', role: 'user', text: 'next question' },
      { kind: 'message', id: 'assistant-9', role: 'assistant', text: 'fresh reply' },
    ]);
    expect(projectAcpChatItems(fixture)).toEqual(state.chatItems);
  });

  // Codex duplicate-message repro (session 52cb3a2c, 2026-07-20): the API
  // bridge splits the agent's single ordered stdio stream into an SSE channel
  // (notifications) and a POST round-trip (RPC responses). codex-acp writes
  // its whole `session/load` history replay BEFORE its response, but the tiny
  // POST response overtakes the still-persisting SSE frames by hundreds of
  // rows — so replayed chunks land AFTER the load-response row and escape the
  // open-load-window guard above. Replayed items carry consolidated
  // `item-N` messageIds whose full text byte-matches an already-streamed live
  // message (`msg_tmp_*`/`rs_*` ids); the reducer must recognize them by
  // content identity, not by ordering.
  test('codex replay chunks that arrive AFTER the session/load response do not duplicate messages', () => {
    const keyedChunk = (
      ordinal: number,
      text: string,
      messageId: string,
      sessionUpdate: 'agent_message_chunk' | 'agent_thought_chunk' = 'agent_message_chunk',
    ): AcpStoredEnvelope => stored(ordinal, 'agent_to_client', {
      jsonrpc: '2.0', method: 'session/update',
      params: { sessionId: 'codex-1', update: { sessionUpdate, messageId, content: { type: 'text', text } } },
    });
    const load = (ordinal: number, id: string): AcpStoredEnvelope => stored(ordinal, 'client_to_agent', {
      jsonrpc: '2.0', id, method: 'session/load', params: { sessionId: 'codex-1', cwd: '/workspace' },
    });
    const loadResult = (ordinal: number, id: string): AcpStoredEnvelope => stored(ordinal, 'agent_to_client', {
      jsonrpc: '2.0', id, result: {},
    });

    const fixture = [
      userPrompt(1, 'make a package', 'p-1', 'codex-1'),
      // Live message streamed as deltas under a codex streaming id.
      keyedChunk(2, 'Hi. What do', 'msg_tmp_a'),
      keyedChunk(3, ' you need?', 'msg_tmp_a'),
      // Live thought streamed under a codex reasoning-stream id.
      keyedChunk(4, 'planning the layout', 'rs_a', 'agent_thought_chunk'),
      // First reconnect: the load RESPONSE row precedes the replay frames.
      load(5, 'load-1'),
      loadResult(6, 'load-1'),
      keyedChunk(7, 'Hi. What do you need?', 'item-2'),
      keyedChunk(8, 'planning the layout', 'item-3', 'agent_thought_chunk'),
      // Second reconnect replays the same items again.
      load(9, 'load-2'),
      loadResult(10, 'load-2'),
      keyedChunk(11, 'Hi. What do you need?', 'item-2'),
      keyedChunk(12, 'planning the layout', 'item-3', 'agent_thought_chunk'),
      // Live traffic resumed after the replay flush must still render.
      keyedChunk(13, 'All done.', 'msg_tmp_b'),
    ];

    let state = emptyReducerState();
    for (const row of fixture) state = reduceEnvelope(state, row);

    expect(state.envelopes).toEqual(fixture);
    expect(state.chatItems).toEqual([
      { kind: 'message', id: 'prompt-1', role: 'user', text: 'make a package' },
      { kind: 'message', id: 'assistant-2', role: 'assistant', text: 'Hi. What do you need?' },
      { kind: 'message', id: 'thought-4', role: 'thought', text: 'planning the layout' },
      { kind: 'message', id: 'assistant-13', role: 'assistant', text: 'All done.' },
    ]);
    expect(projectAcpChatItems(fixture)).toEqual(state.chatItems);
  });

  test('claude-shape replay: same-id fragments re-walking a finished stream after the load response are dropped', () => {
    const keyedChunk = (ordinal: number, text: string, messageId: string): AcpStoredEnvelope =>
      stored(ordinal, 'agent_to_client', {
        jsonrpc: '2.0', method: 'session/update',
        params: { sessionId: 'claude-1', update: { sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text } } },
      });

    const fixture = [
      // Live message streamed as token deltas under a claude msg_* id.
      keyedChunk(1, 'Let me parse this task. ', 'msg_a'),
      keyedChunk(2, 'The user wants a package.', 'msg_a'),
      stored(3, 'client_to_agent', { jsonrpc: '2.0', id: 'load-1', method: 'session/load', params: { sessionId: 'claude-1', cwd: '/w' } }),
      stored(4, 'agent_to_client', { jsonrpc: '2.0', id: 'load-1', result: {} }),
      // Leaked replay re-delivers the SAME message id as paragraph-level
      // fragments (claude granularity differs from the live token deltas).
      keyedChunk(5, 'Let me parse this task. ', 'msg_a'),
      keyedChunk(6, 'The user wants a package.', 'msg_a'),
      // A second reconnect replays the whole message as ONE chunk.
      stored(7, 'client_to_agent', { jsonrpc: '2.0', id: 'load-2', method: 'session/load', params: { sessionId: 'claude-1', cwd: '/w' } }),
      stored(8, 'agent_to_client', { jsonrpc: '2.0', id: 'load-2', result: {} }),
      keyedChunk(9, 'Let me parse this task. The user wants a package.', 'msg_a'),
      // Live traffic after the replay flush must still render.
      keyedChunk(10, 'Package is ready.', 'msg_b'),
    ];

    let state = emptyReducerState();
    for (const row of fixture) state = reduceEnvelope(state, row);
    expect(state.chatItems).toEqual([
      // `msg_b` folds onto the surviving item via the pre-existing
      // consecutive-same-role merge (messageId does not split items today);
      // the replayed copies of msg_a are gone entirely.
      { kind: 'message', id: 'assistant-1', role: 'assistant', text: 'Let me parse this task. The user wants a package.Package is ready.' },
    ]);
  });

  test('pi-shape replay: an id-less complete message byte-equal to an existing item is dropped after a load', () => {
    const fixture = [
      userPrompt(1, 'run the report', 'p-1', 'pi-1'),
      // Pi live messages arrive as complete id-less chunks.
      agentChunk(2, 'Report generated: 42 rows, 0 errors.'),
      stored(3, 'client_to_agent', { jsonrpc: '2.0', id: 'load-1', method: 'session/load', params: { sessionId: 'pi-1', cwd: '/w' } }),
      stored(4, 'agent_to_client', { jsonrpc: '2.0', id: 'load-1', result: {} }),
      // Leaked pi replay: same complete text, still no messageId.
      agentChunk(5, 'Report generated: 42 rows, 0 errors.'),
      // A genuinely different follow-up must render.
      agentChunk(6, 'Anything else?'),
    ];

    let state = emptyReducerState();
    for (const row of fixture) state = reduceEnvelope(state, row);
    const assistants = state.chatItems.filter((i) => i.kind === 'message' && i.role === 'assistant');
    expect(assistants).toEqual([
      // The follow-up merges onto the surviving original per the existing
      // consecutive-same-role rule; the replayed copy itself is gone.
      { kind: 'message', id: 'assistant-2', role: 'assistant', text: 'Report generated: 42 rows, 0 errors.Anything else?' },
    ]);
  });

  test('a live continuation delta echoing its message-opening token is NOT eaten by the replay walk', () => {
    const keyedChunk = (ordinal: number, text: string, messageId: string): AcpStoredEnvelope =>
      stored(ordinal, 'agent_to_client', {
        jsonrpc: '2.0', method: 'session/update',
        params: { sessionId: 'claude-1', update: { sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text } } },
      });

    const fixture = [
      keyedChunk(1, 'I', 'msg_a'),
      keyedChunk(2, ' think', 'msg_a'),
      stored(3, 'client_to_agent', { jsonrpc: '2.0', id: 'load-1', method: 'session/load', params: { sessionId: 'claude-1', cwd: '/w' } }),
      stored(4, 'agent_to_client', { jsonrpc: '2.0', id: 'load-1', result: {} }),
      // The stream KEEPS growing live across the reconnect: `grewAt` only
      // predates the load for finished streams, so a walk may not start on
      // this still-active one even though 'I' prefixes the accumulated text.
      keyedChunk(5, ' so', 'msg_a'),
      keyedChunk(6, 'I', 'msg_a'),
    ];

    let state = emptyReducerState();
    for (const row of fixture) state = reduceEnvelope(state, row);
    expect(state.chatItems).toEqual([
      { kind: 'message', id: 'assistant-1', role: 'assistant', text: 'I think soI' },
    ]);
  });

  test('a same-id delta arriving after a session/load still extends its message (no false replay classification)', () => {
    const keyedChunk = (ordinal: number, text: string, messageId: string): AcpStoredEnvelope =>
      stored(ordinal, 'agent_to_client', {
        jsonrpc: '2.0', method: 'session/update',
        params: { sessionId: 'codex-1', update: { sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text } } },
      });

    const fixture = [
      keyedChunk(1, 'Working on', 'msg_tmp_a'),
      stored(2, 'client_to_agent', { jsonrpc: '2.0', id: 'load-1', method: 'session/load', params: { sessionId: 'codex-1', cwd: '/w' } }),
      stored(3, 'agent_to_client', { jsonrpc: '2.0', id: 'load-1', result: {} }),
      // The turn kept streaming across the reconnect: a genuine NEW delta for
      // the same live stream id must still append, not be dropped as replay.
      keyedChunk(4, ' the fix.', 'msg_tmp_a'),
    ];

    let state = emptyReducerState();
    for (const row of fixture) state = reduceEnvelope(state, row);
    expect(state.chatItems).toEqual([
      { kind: 'message', id: 'assistant-1', role: 'assistant', text: 'Working on the fix.' },
    ]);
  });

  test('a genuinely-new tool_call that interleaves with an open session/load is NOT suppressed', () => {
    // Reproduces D2 (codex `8023ee8f…`): on an error-terminated run the client
    // fires repeated `session/load` auto-resume requests. The daemon's async
    // synthetic outputs `show` (a brand-new `tool_call`) landed inside one of
    // those still-open load windows and was blanket-suppressed by the
    // bootstrap-replay guard — so the Easy-panel Outputs card rendered empty on
    // reload even though the envelope is persisted. A tool_call is deduped by
    // `toolIndex` (a replayed copy merges by id), so it must never be dropped
    // here the way an un-deduped message chunk is.
    const prompt = userPrompt(1, 'make the files', 'prompt-1', 'session-1');
    // session/load request opens a window that stays open (its response arrives
    // AFTER the synthetic show below, mirroring ordinals 84798→84836→85120).
    const load = stored(2, 'client_to_agent', {
      jsonrpc: '2.0', id: 'load-1', method: 'session/load',
      params: { sessionId: 'session-1', cwd: '/workspace' },
    });
    const syntheticShow = stored(3, 'agent_to_client', {
      jsonrpc: '2.0', method: 'session/update',
      params: {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'tool_call', kind: 'other', tool: 'show', title: 'Show',
          status: 'completed', toolCallId: 'kortix-outputs:1',
          rawInput: { items: [{ path: '/workspace/report.pdf' }] },
          _meta: { kortix: { synthetic: 'filesystem-delta', schemaVersion: 1 } },
        },
      },
    });
    const loadResult = stored(4, 'agent_to_client', {
      jsonrpc: '2.0', id: 'load-1', result: { sessionId: 'session-1' },
    });
    const fixture = [prompt, load, syntheticShow, loadResult];

    let state = emptyReducerState();
    for (const row of fixture) state = reduceEnvelope(state, row);

    const toolItems = state.chatItems.filter((item) => item.kind === 'tool');
    expect(toolItems.map((item) => (item as { id: string }).id)).toEqual(['kortix-outputs:1']);
    expect(projectAcpChatItems(fixture)).toEqual(state.chatItems);
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

  // WS3-P2-b, part 1: `clearOpenPrompts` — the wedge-guard's primitive,
  // shared by `reduceEnvelope`'s busy-staleness policy in spirit (same end
  // state) but driven by `AcpSession` directly off a connection-lifecycle
  // signal instead of a transcript row.
  describe('clearOpenPrompts (wedge-guard primitive)', () => {
    test('a no-op (reference-equal) when nothing is open', () => {
      const state = emptyReducerState();
      expect(clearOpenPrompts(state)).toBe(state);

      let withClosedTurn = reduceEnvelope(state, userPrompt(1, 'go', 'req-1', 's1'));
      withClosedTurn = reduceEnvelope(withClosedTurn, stored(2, 'agent_to_client', {
        jsonrpc: '2.0', id: 'req-1', result: { stopReason: 'end_turn' },
      }));
      expect(withClosedTurn.turnState.busy).toBe(false);
      expect(clearOpenPrompts(withClosedTurn)).toBe(withClosedTurn);
    });

    test('clears every open prompt to the same end state a session/cancel row would reach', () => {
      let state = emptyReducerState();
      state = reduceEnvelope(state, userPrompt(1, 'first', 'req-1', 's1'));
      state = reduceEnvelope(state, userPrompt(3, 'second (different session)', 'req-2', 's2'));
      expect(state.turnState.busy).toBe(true);
      expect(state.turnState.pendingPromptIds).toEqual(['req-1', 'req-2']);

      const cleared = clearOpenPrompts(state);

      expect(cleared.turnState).toEqual({ busy: false, pendingPromptIds: [] });
      expect(pendingFromState(cleared)).toEqual({ permissions: [], questions: [] });
      // Deliberately does NOT touch the transcript log or its projections —
      // this is a connection-lifecycle signal, not a transcript row.
      expect(cleared.envelopes).toBe(state.envelopes);
      expect(cleared.chatItems).toBe(state.chatItems);
      expect(cleared.dedupeKeys).toBe(state.dedupeKeys);
    });
  });
});

// Fix for "unrecognized agent event" on legitimate protocol notifications —
// both payload shapes below are captured verbatim from real persisted
// sessions (`kortix.acp_session_envelopes`, dev DB, 2026-07-21): claude-agent-
// acp's `session_info_update` (title/updatedAt), codex-acp's
// `session_info_update` (`_meta.codex.threadStatus`), and both harnesses'
// `config_option_update` (full `configOptions` replacement, e.g. after an
// in-transcript `/model` slash command).
describe('session_info_update / config_option_update', () => {
  function sessionInfoUpdate(ordinal: number, update: Record<string, unknown>): AcpStoredEnvelope {
    return stored(ordinal, 'agent_to_client', {
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 'sess-1', update: { sessionUpdate: 'session_info_update', ...update } },
    });
  }

  function configOptionUpdate(ordinal: number, configOptions: unknown[]): AcpStoredEnvelope {
    return stored(ordinal, 'agent_to_client', {
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 'sess-1', update: { sessionUpdate: 'config_option_update', configOptions } },
    });
  }

  test('claude-shape session_info_update (title/updatedAt) folds into sessionInfo, no chat item', () => {
    let state = emptyReducerState();
    state = reduceEnvelope(
      state,
      sessionInfoUpdate(1, { title: 'Reply with exactly: ACP_PONG', updatedAt: '2026-07-12T02:30:47.426Z' }),
    );

    expect(state.sessionInfo).toEqual({
      title: 'Reply with exactly: ACP_PONG',
      updatedAt: '2026-07-12T02:30:47.426Z',
      threadStatus: null,
    });
    expect(state.chatItems).toEqual([]);
    expect(state.envelopes).toHaveLength(1); // still logged, just not a chat item
  });

  test('codex-shape session_info_update (_meta.codex.threadStatus) folds into sessionInfo, no chat item', () => {
    let state = emptyReducerState();
    state = reduceEnvelope(
      state,
      sessionInfoUpdate(1, { _meta: { codex: { threadStatus: { type: 'active', activeFlags: [] } } } }),
    );

    expect(state.sessionInfo).toEqual({
      title: null,
      updatedAt: null,
      threadStatus: { type: 'active', activeFlags: [] },
    });
    expect(state.chatItems).toEqual([]);
  });

  test('a later update merges onto sessionInfo instead of replacing it wholesale', () => {
    let state = emptyReducerState();
    state = reduceEnvelope(state, sessionInfoUpdate(1, { title: 'Original title' }));
    state = reduceEnvelope(
      state,
      sessionInfoUpdate(2, { _meta: { codex: { threadStatus: { type: 'idle', activeFlags: [] } } } }),
    );

    // The threadStatus-only update must not blank out the title set earlier.
    expect(state.sessionInfo).toEqual({
      title: 'Original title',
      updatedAt: null,
      threadStatus: { type: 'idle', activeFlags: [] },
    });
  });

  test('config_option_update replaces liveConfigOptions with the full list, no chat item', () => {
    const configOptions = [
      { id: 'mode', name: 'Mode', type: 'select', category: 'mode', currentValue: 'agent', options: [] },
      { id: 'model', name: 'Model', type: 'select', category: 'model', currentValue: 'opus', options: [] },
    ];
    let state = emptyReducerState();
    expect(state.liveConfigOptions).toBeNull();

    state = reduceEnvelope(state, configOptionUpdate(1, configOptions));

    expect(state.liveConfigOptions).toEqual(configOptions);
    expect(state.chatItems).toEqual([]);
  });

  test('liveConfigOptions keeps its previous reference when no config_option_update has arrived — untouched flushes stay cheap', () => {
    let state = emptyReducerState();
    state = reduceEnvelope(state, configOptionUpdate(1, [{ id: 'model', options: [] }]));
    const afterFirstUpdate = state.liveConfigOptions;

    state = reduceEnvelope(state, agentChunk(2, 'unrelated message text'));

    expect(state.liveConfigOptions).toBe(afterFirstUpdate); // same reference, not a new array
  });

  test('a genuinely unknown session/update kind still falls back to a raw chat item (unchanged safety net)', () => {
    let state = emptyReducerState();
    state = reduceEnvelope(
      state,
      stored(1, 'agent_to_client', {
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: 'sess-1', update: { sessionUpdate: 'some_future_protocol_extension', foo: 'bar' } },
      }),
    );

    expect(state.chatItems).toEqual([
      { kind: 'raw', method: 'some_future_protocol_extension', data: { sessionUpdate: 'some_future_protocol_extension', foo: 'bar' } },
    ]);
    expect(state.sessionInfo).toBeNull();
    expect(state.liveConfigOptions).toBeNull();
  });
});

// `available_commands_update` (protocol/v1/slash-commands.md) — real payloads
// captured VERBATIM from `kortix.acp_session_envelopes` (local DB,
// 2026-07-22). Confirms, against real data, that ALL FOUR integrated
// harnesses advertise non-empty command lists (the composer's "/" palette
// previously discarded every one of them — `useRuntimeCommands()` hardcoded
// `commands: []`).
describe('available_commands_update', () => {
  function availableCommandsUpdate(ordinal: number, availableCommands: unknown[]): AcpStoredEnvelope {
    return stored(ordinal, 'agent_to_client', {
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 'sess-1', update: { sessionUpdate: 'available_commands_update', availableCommands } },
    });
  }

  test('OpenCode-shape payload (description only, no input) folds into availableCommands, no chat item', () => {
    let state = emptyReducerState();
    expect(state.availableCommands).toEqual([]);

    state = reduceEnvelope(state, availableCommandsUpdate(1, [
      {
        name: 'customize-opencode',
        description: "Use ONLY when the user is editing or creating opencode's own configuration",
      },
      { name: 'init', description: 'guided AGENTS.md setup' },
      { name: 'review', description: 'review changes [commit|branch|pr], defaults to uncommitted' },
    ]));

    expect(state.availableCommands).toEqual([
      { name: 'customize-opencode', description: "Use ONLY when the user is editing or creating opencode's own configuration", hint: null },
      { name: 'init', description: 'guided AGENTS.md setup', hint: null },
      { name: 'review', description: 'review changes [commit|branch|pr], defaults to uncommitted', hint: null },
    ]);
    expect(state.chatItems).toEqual([]);
  });

  test('pi-acp-shape payload (input.hint present) folds hint through, and explicit input: null becomes hint: null', () => {
    let state = emptyReducerState();

    state = reduceEnvelope(state, availableCommandsUpdate(1, [
      { name: 'goal', input: { hint: '[<objective>|clear|pause|resume]' }, description: 'Set, pause, resume, or clear a task goal.' },
      { name: 'schedule', input: null, description: 'Create, update, list, or run scheduled cloud agents (routines) that execute on a cron schedule.' },
    ]));

    expect(state.availableCommands).toEqual([
      { name: 'goal', description: 'Set, pause, resume, or clear a task goal.', hint: '[<objective>|clear|pause|resume]' },
      { name: 'schedule', description: 'Create, update, list, or run scheduled cloud agents (routines) that execute on a cron schedule.', hint: null },
    ]);
  });

  test('claude-agent-acp-shape and codex-acp-shape payloads (verified live, real non-empty lists) fold cleanly', () => {
    let state = emptyReducerState();

    state = reduceEnvelope(state, availableCommandsUpdate(1, [
      { name: 'mcp', input: null, description: 'List configured Model Context Protocol (MCP) tools.' },
      { name: 'review', input: { hint: 'optional review instructions' }, description: 'Review uncommitted changes, or review with custom instructions.' },
    ]));

    expect(state.availableCommands).toEqual([
      { name: 'mcp', description: 'List configured Model Context Protocol (MCP) tools.', hint: null },
      { name: 'review', description: 'Review uncommitted changes, or review with custom instructions.', hint: 'optional review instructions' },
    ]);
  });

  test('a later update REPLACES the list wholesale (harness always sends its full current set, never a delta)', () => {
    let state = emptyReducerState();
    state = reduceEnvelope(state, availableCommandsUpdate(1, [{ name: 'init', description: null }]));
    state = reduceEnvelope(state, availableCommandsUpdate(2, [{ name: 'review', description: null }]));

    expect(state.availableCommands).toEqual([{ name: 'review', description: null, hint: null }]);
  });

  test('a command entry missing `name` is dropped instead of producing a nameless command', () => {
    let state = emptyReducerState();
    state = reduceEnvelope(state, availableCommandsUpdate(1, [
      { description: 'no name, malformed' },
      { name: 'valid', description: 'kept' },
    ]));

    expect(state.availableCommands).toEqual([{ name: 'valid', description: 'kept', hint: null }]);
  });

  test('availableCommands keeps its previous reference when no available_commands_update has arrived — untouched flushes stay cheap', () => {
    let state = emptyReducerState();
    state = reduceEnvelope(state, availableCommandsUpdate(1, [{ name: 'init', description: null }]));
    const afterFirstUpdate = state.availableCommands;

    state = reduceEnvelope(state, agentChunk(2, 'unrelated message text'));

    expect(state.availableCommands).toBe(afterFirstUpdate); // same reference, not a new array
  });
});

// Pi startup/update-notice suppression (2026-07-22 decree): the pi adapter
// sends its own "pi vX.Y.Z" / "New version available…" banner as a genuine
// `agent_message_chunk`, which used to render as a real chat bubble — twice
// per reconnect. Payload captured VERBATIM from a real live session
// (`kortix.acp_session_envelopes`, local DB, 2026-07-22).
describe('pi startup/update-notice suppression', () => {
  const REAL_PI_BANNER =
    'pi v0.80.6\n---\n\n---\nNew version available: v0.81.1 (installed v0.80.6). Run: `npm i -g @earendil-works/pi-coding-agent`\n';

  test('the real captured pi startup banner is filtered out of the message stream — routed to a raw, inspectable item instead', () => {
    let state = emptyReducerState();
    state = reduceEnvelope(state, agentChunk(1, REAL_PI_BANNER));

    expect(state.chatItems).toHaveLength(1);
    expect(state.chatItems[0]?.kind).toBe('raw');
    expect((state.chatItems[0] as { method: string }).method).toBe('harness_startup_notice');
    // Inspectable, not swallowed — the full update is still on the item.
    expect((state.chatItems[0] as { data: { content: { text: string } } }).data.content.text).toBe(
      REAL_PI_BANNER,
    );
  });

  test('the banner does not merge with, or get mistaken as a replay of, a real adjacent message', () => {
    let state = emptyReducerState();
    state = reduceEnvelope(state, agentChunk(1, REAL_PI_BANNER));
    state = reduceEnvelope(state, agentChunk(2, 'Here is the real answer to your question.'));

    expect(state.chatItems).toHaveLength(2);
    expect(state.chatItems[0]?.kind).toBe('raw');
    expect(state.chatItems[1]?.kind).toBe('message');
    expect((state.chatItems[1] as { text: string }).text).toBe(
      'Here is the real answer to your question.',
    );
  });

  test('a version banner heading alone (no update-notice sentence — already on the latest version) is still filtered', () => {
    let state = emptyReducerState();
    state = reduceEnvelope(state, agentChunk(1, 'pi v0.81.1\n---\n'));

    expect(state.chatItems).toHaveLength(1);
    expect(state.chatItems[0]?.kind).toBe('raw');
  });

  test('a real agent message that merely mentions a version number is NEVER caught — the filter is scoped to the exact banner shapes', () => {
    let state = emptyReducerState();
    state = reduceEnvelope(
      state,
      agentChunk(1, 'I upgraded pi v0.80.6 in the sandbox and reran the tests — all green.'),
    );

    expect(state.chatItems).toHaveLength(1);
    expect(state.chatItems[0]?.kind).toBe('message');
  });

  test('an agent_thought_chunk with the same banner text is left alone — the filter is scoped to agent_message_chunk only', () => {
    let state = emptyReducerState();
    state = reduceEnvelope(
      state,
      stored(1, 'agent_to_client', {
        jsonrpc: '2.0',
        method: 'session/update',
        params: { update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: REAL_PI_BANNER } } },
      }),
    );

    expect(state.chatItems).toHaveLength(1);
    expect(state.chatItems[0]?.kind).toBe('message');
    expect((state.chatItems[0] as { role: string }).role).toBe('thought');
  });

  test('two reconnects each emit the banner once — both are filtered (documents the real "TWO New version available blocks" report)', () => {
    let state = emptyReducerState();
    state = reduceEnvelope(state, agentChunk(1, REAL_PI_BANNER));
    state = reduceEnvelope(state, agentChunk(2, 'first reply'));
    state = reduceEnvelope(state, agentChunk(3, REAL_PI_BANNER));
    state = reduceEnvelope(state, agentChunk(4, 'second reply'));

    const kinds = state.chatItems.map((item) => item.kind);
    expect(kinds).toEqual(['raw', 'message', 'raw', 'message']);
  });
});

// WS3-P2-b, part 2: bounded `dedupeKeys`.
describe('dedupeKeys bound', () => {
  // Each row gets its own `toolCallId` (derived from `streamEventId`), so —
  // unlike consecutive `agent_message_chunk` rows, which the reducer
  // deliberately coalesces into one chat item (see `reduceEnvelope`'s
  // message-merge branch) — every ACCEPTED row here always produces its own
  // distinct `chatItems` entry. That keeps `chatItems.length` a direct,
  // uncomplicated proxy for "how many DISTINCT rows did the dedupe check let
  // through", which is exactly what these tests need to inspect; the
  // dedupe check itself (top of `reduceEnvelope`) doesn't care what kind of
  // `agent_to_client` row it's guarding, so this is a faithful stand-in for
  // any live/history update.
  function agentUpdate(ordinal: number, streamEventId: number, title: string): AcpStoredEnvelope {
    return stored(ordinal, 'agent_to_client', {
      jsonrpc: '2.0', method: 'session/update',
      params: { update: { sessionUpdate: 'tool_call', toolCallId: `call-${streamEventId}`, title } },
    }, streamEventId);
  }

  // Keep in sync with reduce.ts's private `DEDUPE_WINDOW` — not exported
  // (an implementation constant, not part of the documented contract; see
  // `AcpReducerState.dedupeKeys`'s doc), so the bound is pinned here as a
  // literal instead.
  const DEDUPE_WINDOW = 256;

  test('growth: folding far more rows than the window keeps dedupeKeys bounded, not O(rows)', () => {
    const rowCount = DEDUPE_WINDOW * 10;
    let state = emptyReducerState();
    for (let i = 1; i <= rowCount; i += 1) {
      state = reduceEnvelope(state, agentUpdate(i, i, `chunk-${i}`));
    }

    expect(state.envelopes).toHaveLength(rowCount);
    expect(state.dedupeKeys.size).toBeLessThanOrEqual(DEDUPE_WINDOW);
  });

  test('a duplicate WITHIN the window is still dropped, exactly like the unbounded Set did', () => {
    let state = emptyReducerState();
    state = reduceEnvelope(state, agentUpdate(1, 7, 'hi'));
    const afterFirst = state;

    // A handful of unrelated events land in between — well within the window.
    for (let i = 2; i <= 10; i += 1) state = reduceEnvelope(state, agentUpdate(i, i + 100, `noise-${i}`));

    const duplicate = agentUpdate(20, 7, 'again');
    const afterDuplicate = reduceEnvelope(state, duplicate);

    // The duplicate is rejected before ever reaching the accept path, so the
    // interleaving noise since the first `streamEventId: 7` row changes
    // nothing about whether it's still recognized.
    const firstTool = afterFirst.chatItems.find((item) => item.kind === 'tool');
    expect((firstTool as { title: string }).title).toBe('hi');
    expect(afterDuplicate.chatItems.filter((item) => item.kind === 'tool')).toHaveLength(10);
    expect(afterDuplicate).toBe(state); // duplicate row: reference-equal no-op
  });

  test('replay overlap: a Last-Event-ID reconnect re-delivering a small recent tail dedupes every row in that tail', () => {
    // Simulates 50 live events already folded, then a reconnect re-sends
    // the last 5 (a realistic Last-Event-ID replay tail) before continuing
    // with genuinely new ones — every re-sent row must be dropped, and the
    // genuinely new ones after it must still land.
    let state = emptyReducerState();
    for (let i = 1; i <= 50; i += 1) state = reduceEnvelope(state, agentUpdate(i, i, `chunk-${i}`));
    const beforeReplay = state;

    for (let i = 46; i <= 50; i += 1) state = reduceEnvelope(state, agentUpdate(1000 + i, i, `REPLAYED-${i}`));
    expect(state.chatItems).toEqual(beforeReplay.chatItems);
    expect(state.envelopes).toHaveLength(50); // no replayed row appended

    state = reduceEnvelope(state, agentUpdate(200, 51, 'chunk-51'));
    expect(state.envelopes).toHaveLength(51);
  });

  test('out-of-order-within-window: a genuinely NEW row with a SMALLER streamEventId than one already folded is still accepted (never silently mistaken for a duplicate)', () => {
    // Correctness bar from the WS3-P2-b brief: unlike `AcpSession`'s
    // `historyOrdinals` bound (which can safely collapse to a bare
    // high-water mark because `enqueueHistory`'s full-refetch contract rules
    // this case out), `dedupeKeys` backs a PUBLIC function any caller can
    // feed an arbitrarily-ordered `rows` array — so it must keep matching by
    // EXACT key, never by a "smaller than something already seen" shortcut.
    let state = emptyReducerState();
    state = reduceEnvelope(state, agentUpdate(1, 20, 'seen-first'));
    state = reduceEnvelope(state, agentUpdate(2, 3, 'genuinely new, smaller id'));

    expect(state.envelopes).toHaveLength(2);
    const titles = state.chatItems.filter((item) => item.kind === 'tool').map((item) => (item as { title: string }).title);
    expect(titles).toEqual(['seen-first', 'genuinely new, smaller id']);
  });

  test('eviction boundary: a genuine duplicate re-arriving after aging out of the window is (honestly) no longer recognized', () => {
    // Documents the correctness trade `dedupeKeys`'s bound makes (see its
    // doc comment) rather than hiding it — this is NOT a bug to fix, it is
    // the accepted cost of O(window) memory instead of O(session length),
    // justified by Last-Event-ID replay never re-delivering more than a
    // small bounded tail in practice.
    let state = emptyReducerState();
    state = reduceEnvelope(state, agentUpdate(1, 1, 'original'));
    for (let i = 2; i <= DEDUPE_WINDOW + 5; i += 1) state = reduceEnvelope(state, agentUpdate(i, i, `chunk-${i}`));

    const beforeStaleDuplicate = state;
    const staleDuplicate = agentUpdate(9999, 1, 'stale-duplicate');
    state = reduceEnvelope(state, staleDuplicate);

    // Aged out of the window: treated as new, not as a duplicate.
    expect(state.envelopes).toHaveLength(beforeStaleDuplicate.envelopes.length + 1);
  });
});

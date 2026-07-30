import { describe, expect, test } from 'bun:test';

import { type AcpProjection, applyAcpEnvelope, createAcpProjection } from './projection';

function update(
  projection: AcpProjection,
  sessionUpdate: string,
  fields: Record<string, unknown> = {},
) {
  return applyAcpEnvelope(projection, {
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId: 'ses_1',
      update: { sessionUpdate, ...fields },
    },
  });
}

describe('ACP to Kortix session projection', () => {
  test('projects persisted client session/prompt envelopes as user messages', () => {
    const state = applyAcpEnvelope(createAcpProjection('native-1'), {
      jsonrpc: '2.0',
      id: 'prompt-1',
      method: 'session/prompt',
      params: {
        sessionId: 'native-1',
        prompt: [
          { type: 'text', text: 'first ' },
          { type: 'text', text: 'question' },
        ],
      },
    });

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.info.role).toBe('user');
    expect(state.messages[0]?.parts).toMatchObject([{ type: 'text', text: 'first question' }]);
  });

  test('preserves OpenCode message ids from ACP transcript replay', () => {
    let state = createAcpProjection('ses_1');
    state = update(state, 'user_message_chunk', {
      messageId: 'msg_user_1',
      content: { type: 'text', text: 'first prompt' },
    });
    state = update(state, 'agent_message_chunk', {
      messageId: 'msg_assistant_1',
      content: { type: 'text', text: 'first answer' },
    });
    state = update(state, 'user_message_chunk', {
      messageId: 'msg_user_2',
      content: { type: 'text', text: 'second prompt' },
    });

    expect(state.messages.map((message) => message.info.id)).toEqual([
      'msg_user_1',
      'msg_assistant_1',
      'msg_user_2',
    ]);
  });

  test('projects user, thought, assistant, usage, and stop reason', () => {
    let state = createAcpProjection('ses_1');
    state = update(state, 'user_message_chunk', {
      content: { type: 'text', text: 'hello' },
    });
    state = update(state, 'agent_thought_chunk', {
      content: { type: 'text', text: 'think ' },
    });
    state = update(state, 'agent_thought_chunk', {
      content: { type: 'text', text: 'more' },
    });
    state = update(state, 'agent_message_chunk', {
      content: { type: 'text', text: 'ACP_' },
    });
    state = update(state, 'agent_message_chunk', {
      content: { type: 'text', text: 'PONG' },
    });
    state = applyAcpEnvelope(state, {
      jsonrpc: '2.0',
      id: 'prompt-1',
      result: {
        stopReason: 'end_turn',
        usage: {
          inputTokens: 10,
          outputTokens: 2,
          thoughtTokens: 3,
          cachedReadTokens: 4,
          cachedWriteTokens: 5,
        },
      },
    });

    expect(state.messages.map((message) => message.info.role)).toEqual(['user', 'assistant']);
    expect(state.messages[0]?.parts).toMatchObject([{ type: 'text', text: 'hello' }]);
    expect(state.messages[1]?.parts).toMatchObject([
      { type: 'reasoning', text: 'think more' },
      { type: 'text', text: 'ACP_PONG' },
      {
        type: 'step-finish',
        reason: 'end_turn',
        tokens: {
          input: 10,
          output: 2,
          reasoning: 3,
          cache: { read: 4, write: 5 },
        },
      },
    ]);
    expect(state.status).toEqual({ type: 'idle' });
  });

  test('appends an unscoped text chunk that arrives after the prompt result', () => {
    let state = createAcpProjection('ses_1');
    state = update(state, 'user_message_chunk', {
      content: { type: 'text', text: 'reply exactly' },
    });
    state = update(state, 'agent_message_chunk', {
      content: { type: 'text', text: 'PI_FIRST_' },
    });
    state = applyAcpEnvelope(state, {
      jsonrpc: '2.0',
      id: 'prompt-1',
      result: { stopReason: 'end_turn' },
    });
    state = update(state, 'agent_message_chunk', {
      content: { type: 'text', text: '123' },
    });

    expect(state.messages).toHaveLength(2);
    expect(state.messages[1]?.parts).toMatchObject([
      { type: 'text', text: 'PI_FIRST_123' },
      { type: 'step-finish', reason: 'end_turn' },
    ]);
    expect(state.messages[1]?.info.time).toMatchObject({
      completed: expect.any(Number),
    });
    expect(state.status).toEqual({ type: 'idle' });
  });

  test('preserves upstream message boundaries across one ACP prompt', () => {
    let state = createAcpProjection('ses_1');
    state = update(state, 'user_message_chunk', {
      messageId: 'msg_user_1',
      content: { type: 'text', text: 'Research Marko' },
    });
    state = update(state, 'agent_thought_chunk', {
      messageId: 'msg_assistant_1',
      content: { type: 'text', text: 'First thought. ' },
    });
    state = update(state, 'agent_message_chunk', {
      messageId: 'msg_assistant_1',
      content: { type: 'text', text: 'First update.' },
    });
    state = update(state, 'tool_call', {
      toolCallId: 'call_1',
      title: 'web_search',
      kind: 'other',
      status: 'pending',
      rawInput: { query: 'Marko' },
    });
    state = update(state, 'agent_thought_chunk', {
      messageId: 'msg_assistant_2',
      content: { type: 'text', text: 'Second thought.' },
    });
    state = update(state, 'agent_message_chunk', {
      messageId: 'msg_assistant_2',
      content: { type: 'text', text: 'Second update.' },
    });
    state = update(state, 'agent_message_chunk', {
      messageId: 'msg_assistant_3',
      content: { type: 'text', text: 'Third update.' },
    });

    expect(state.messages.map((message) => message.info.id)).toEqual([
      'msg_user_1',
      'msg_assistant_1',
      'msg_assistant_2',
      'msg_assistant_3',
    ]);
    expect(state.messages.map((message) => message.info.role)).toEqual([
      'user',
      'assistant',
      'assistant',
      'assistant',
    ]);
    expect(state.messages[1]?.info).toMatchObject({
      parentID: 'msg_user_1',
      time: { completed: expect.any(Number) },
    });
    expect(state.messages[1]?.parts).toMatchObject([
      { type: 'reasoning', text: 'First thought. ' },
      { type: 'text', text: 'First update.' },
      { type: 'tool', callID: 'call_1' },
    ]);
    expect(state.messages[2]?.info).toMatchObject({
      parentID: 'msg_user_1',
      time: { completed: expect.any(Number) },
    });
    expect(state.messages[2]?.parts).toMatchObject([
      { type: 'reasoning', text: 'Second thought.' },
      { type: 'text', text: 'Second update.' },
    ]);
    expect(state.messages[3]?.info).toMatchObject({
      parentID: 'msg_user_1',
    });
    expect(
      state.messages[3] && 'completed' in state.messages[3].info.time
        ? state.messages[3].info.time.completed
        : undefined,
    ).toBeUndefined();
    expect(state.messages[3]?.parts).toMatchObject([{ type: 'text', text: 'Third update.' }]);
  });

  test('routes late tool updates to the assistant message that owns the call', () => {
    let state = createAcpProjection('ses_1');
    state = update(state, 'agent_message_chunk', {
      messageId: 'msg_assistant_1',
      content: { type: 'text', text: 'Searching.' },
    });
    state = update(state, 'tool_call', {
      toolCallId: 'call_1',
      title: 'web_search',
      kind: 'other',
      status: 'pending',
      rawInput: { query: 'Marko' },
    });
    state = update(state, 'agent_message_chunk', {
      messageId: 'msg_assistant_2',
      content: { type: 'text', text: 'Still working.' },
    });
    state = update(state, 'tool_call_update', {
      toolCallId: 'call_1',
      status: 'completed',
      rawOutput: { output: 'Found' },
    });

    expect(state.messages).toHaveLength(2);
    expect(state.messages[0]?.parts).toMatchObject([
      { type: 'text', text: 'Searching.' },
      {
        type: 'tool',
        callID: 'call_1',
        state: { status: 'completed', output: 'Found' },
      },
    ]);
    expect(state.messages[1]?.parts).toMatchObject([{ type: 'text', text: 'Still working.' }]);
  });

  test('projects tool calls, tool updates, and plans', () => {
    let state = createAcpProjection('ses_1');
    state = update(state, 'tool_call', {
      toolCallId: 'call_1',
      title: 'Read file',
      kind: 'read',
      status: 'in_progress',
      rawInput: { path: 'README.md' },
    });
    state = update(state, 'tool_call_update', {
      toolCallId: 'call_1',
      status: 'completed',
      rawOutput: { content: 'ok' },
    });
    state = update(state, 'plan', {
      entries: [
        { content: 'Inspect', status: 'completed', priority: 'high' },
        { content: 'Change', status: 'in_progress', priority: 'medium' },
      ],
    });

    expect(state.messages[0]?.parts[0]).toMatchObject({
      type: 'tool',
      callID: 'call_1',
      tool: 'read',
      state: {
        status: 'completed',
        input: { path: 'README.md' },
        output: '{"content":"ok"}',
      },
    });
    expect(state.todos).toEqual([
      { content: 'Inspect', status: 'completed', priority: 'high' },
      { content: 'Change', status: 'in_progress', priority: 'medium' },
    ]);
  });

  test('preserves native tool names instead of ACP protocol kinds', () => {
    let state = createAcpProjection('ses_1');
    state = update(state, 'tool_call', {
      toolCallId: 'bash_1',
      title: 'bash',
      kind: 'execute',
      status: 'pending',
      rawInput: {},
    });
    state = update(state, 'tool_call_update', {
      toolCallId: 'bash_1',
      title: 'ls -la /workspace',
      kind: 'execute',
      status: 'in_progress',
      rawInput: { command: 'ls -la /workspace' },
    });
    state = update(state, 'tool_call_update', {
      toolCallId: 'bash_1',
      title: 'ls -la /workspace',
      kind: 'execute',
      status: 'completed',
      rawOutput: { output: 'README.md' },
    });
    state = update(state, 'tool_call', {
      toolCallId: 'todo_1',
      title: 'todowrite',
      kind: 'other',
      status: 'pending',
      rawInput: {},
    });
    state = update(state, 'tool_call_update', {
      toolCallId: 'todo_1',
      title: '2 todos',
      kind: 'other',
      status: 'completed',
      rawInput: {
        todos: [
          { content: 'Research', status: 'completed' },
          { content: 'Create deck', status: 'completed' },
        ],
      },
      rawOutput: [],
    });
    state = update(state, 'tool_call', {
      toolCallId: 'show_1',
      title: 'show',
      kind: 'other',
      status: 'pending',
      rawInput: {},
    });
    state = update(state, 'tool_call_update', {
      toolCallId: 'show_1',
      title: 'show',
      kind: 'other',
      status: 'completed',
      rawOutput: { success: true },
    });

    expect(state.messages[0]?.parts).toMatchObject([
      {
        type: 'tool',
        tool: 'bash',
        state: {
          status: 'completed',
          title: 'ls -la /workspace',
          input: { command: 'ls -la /workspace' },
          output: 'README.md',
        },
      },
      {
        type: 'tool',
        tool: 'todowrite',
        state: {
          status: 'completed',
          title: '2 todos',
          input: {
            todos: [
              { content: 'Research', status: 'completed' },
              { content: 'Create deck', status: 'completed' },
            ],
          },
        },
      },
      {
        type: 'tool',
        tool: 'show',
        state: {
          status: 'completed',
          title: 'Show Output',
        },
      },
    ]);
  });

  test('projects item plan updates and plan removal', () => {
    let state = createAcpProjection('ses_1');
    state = update(state, 'plan_update', {
      plan: {
        type: 'items',
        planId: 'plan-1',
        entries: [
          { content: 'Inspect', status: 'completed', priority: 'high' },
          { content: 'Verify', status: 'pending', priority: 'medium' },
        ],
      },
    });
    expect(state.todos).toEqual([
      { content: 'Inspect', status: 'completed', priority: 'high' },
      { content: 'Verify', status: 'pending', priority: 'medium' },
    ]);

    state = update(state, 'plan_removed', { planId: 'plan-1' });
    expect(state.todos).toEqual([]);
  });

  test('tracks permission and question requests until a response closes them', () => {
    let state = createAcpProjection('ses_1');
    state = applyAcpEnvelope(state, {
      jsonrpc: '2.0',
      id: 'permission-1',
      method: 'session/request_permission',
      params: {
        sessionId: 'ses_1',
        toolCall: { toolCallId: 'call_1', title: 'Run command' },
        options: [
          { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
        ],
      },
    });
    state = applyAcpEnvelope(state, {
      jsonrpc: '2.0',
      id: 'question-1',
      method: 'elicitation/create',
      params: {
        sessionId: 'ses_1',
        message: 'Choose one',
        requestedSchema: {
          type: 'object',
          properties: {
            choice: { type: 'string', enum: ['a', 'b'] },
          },
        },
      },
    });
    expect(state.permissions).toHaveLength(1);
    expect(state.questions).toHaveLength(1);

    state = applyAcpEnvelope(state, {
      jsonrpc: '2.0',
      id: 'permission-1',
      result: { outcome: { outcome: 'selected', optionId: 'allow_once' } },
    });
    state = applyAcpEnvelope(state, {
      jsonrpc: '2.0',
      id: 'question-1',
      result: { action: 'accept', content: { choice: 'a' } },
    });
    expect(state.permissions).toEqual([]);
    expect(state.questions).toEqual([]);
  });

  test('projects command, mode, config, session information, and usage updates', () => {
    let state = createAcpProjection('ses_1');
    state = update(state, 'available_commands_update', {
      availableCommands: [{ name: 'review', description: 'Review changes' }],
    });
    state = update(state, 'current_mode_update', {
      currentModeId: 'plan',
    });
    state = update(state, 'config_option_update', {
      configOptions: [{ id: 'model', currentValue: 'kortix/glm-5.2' }],
    });
    state = update(state, 'session_info_update', {
      title: 'ACP session',
      updatedAt: '2026-07-25T00:00:00.000Z',
    });
    state = update(state, 'usage_update', {
      used: 1024,
      size: 8192,
      cost: { amount: 0.04, currency: 'USD' },
    });

    expect(state.availableCommands).toEqual([{ name: 'review', description: 'Review changes' }]);
    expect(state.currentModeId).toBe('plan');
    expect(state.configOptions).toEqual([{ id: 'model', currentValue: 'kortix/glm-5.2' }]);
    expect(state.sessionInfo).toEqual({
      title: 'ACP session',
      updatedAt: '2026-07-25T00:00:00.000Z',
    });
    expect(state.usage).toEqual({
      used: 1024,
      size: 8192,
      cost: { amount: 0.04, currency: 'USD' },
    });
  });

  test('ignores updates for a different ACP session', () => {
    const state = createAcpProjection('ses_1');
    const next = applyAcpEnvelope(state, {
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'ses_other',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'leak' },
        },
      },
    });
    expect(next).toBe(state);
  });

  test('a newer assistant message terminalizes an unresolved tool from the previous message', () => {
    let state = createAcpProjection('ses_1');
    state = update(state, 'agent_thought_chunk', {
      messageId: 'msg_assistant_1',
      content: { type: 'text', text: 'Checking the files.' },
    });
    state = update(state, 'tool_call', {
      toolCallId: 'call_stale',
      title: 'bash',
      kind: 'execute',
      status: 'in_progress',
      rawInput: { command: 'test -f deck.pptx' },
    });
    state = update(state, 'agent_message_chunk', {
      messageId: 'msg_assistant_2',
      content: { type: 'text', text: 'The deck is complete.' },
    });

    const previousAssistant = state.messages[0];
    expect(previousAssistant?.info.role).toBe('assistant');
    if (previousAssistant?.info.role !== 'assistant') {
      throw new Error('Expected the first projected message to be an assistant message');
    }
    expect(previousAssistant.info.time.completed).toEqual(expect.any(Number));
    expect(state.messages[0]?.parts).toContainEqual(
      expect.objectContaining({
        type: 'tool',
        callID: 'call_stale',
        state: expect.objectContaining({
          status: 'completed',
          output: '',
          time: expect.objectContaining({ end: expect.any(Number) }),
        }),
      }),
    );
    expect(state.messages[1]?.info.id).toBe('msg_assistant_2');
  });
});

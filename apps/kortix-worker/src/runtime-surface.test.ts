import { describe, expect, test } from 'bun:test';
import type { AssistantMessage, Session, ToolPart, UserMessage } from '@opencode-ai/sdk/v2';
import { RuntimeSurface } from './runtime-surface.ts';

const WIRE_ID = /^msg_[0-9a-f]{12}[A-Za-z0-9]{14}$/;

function restored() {
  return [
    { role: 'user', content: [{ type: 'text', text: 'first question' }], timestamp: 1000 },
    { role: 'assistant', content: [{ type: 'text', text: 'first answer' }], timestamp: 2000 },
    { role: 'user', content: [{ type: 'text', text: 'second question' }], timestamp: 3000 },
    { role: 'assistant', content: [{ type: 'text', text: 'second answer' }], timestamp: 4000 },
  ];
}

// P1.8: one pi instance IS one session, so a box that comes back must come back
// with the same conversation. Before this, a restarted worker served an EMPTY
// /messages while the durable log held the whole transcript — the session
// answered with no memory of what had been said.
describe('RuntimeSurface.seedRestoredMessages', () => {
  test('rebuilds the transcript in order, with real wire ids', () => {
    const surface = new RuntimeSurface({ sessionId: 's', agentName: 'kortix' });
    expect(surface.seedRestoredMessages(restored())).toBe(4);

    const page = surface.transcript.page({ limit: 50, before: null });
    expect(page.messages.map((m) => m.info.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(page.messages.map((m) => m.parts.map((p: any) => p.text).join(''))).toEqual([
      'first question',
      'first answer',
      'second question',
      'second answer',
    ]);

    // The id IS the transcript's sort key, and the web client splits on
    // /^msg_[0-9a-f]{12}/ — a non-conforming id sorts below the whole
    // transcript and every reply reattaches to the wrong question.
    const ids = page.messages.map((m) => m.info.id as string);
    for (const id of ids) expect(id).toMatch(WIRE_ID);
    expect(ids).toEqual([...ids].sort());
  });

  test('a reply minted after the restore sorts ABOVE the restored transcript', () => {
    const surface = new RuntimeSurface({ sessionId: 's' });
    surface.seedRestoredMessages(restored());
    const ids = surface.transcript
      .page({ limit: 50, before: null })
      .messages.map((m) => m.info.id as string);
    // Otherwise the next answer lands back inside history.
    expect(surface.mintMessageId() > ids[ids.length - 1]).toBe(true);
  });

  test('reapplying the same legacy history is idempotent', () => {
    const surface = new RuntimeSurface({ sessionId: 's' });
    surface.seedRestoredMessages(restored());
    const first = surface.transcript
      .page({ limit: 50, before: null })
      .messages.map((message) => message.info.id);

    surface.seedRestoredMessages(restored());
    const second = surface.transcript
      .page({ limit: 50, before: null })
      .messages.map((message) => message.info.id);

    expect(second).toEqual(first);
    expect(surface.transcript.count).toBe(4);
  });

  test('admits a new explicit user id only above the durable transcript floor', () => {
    const surface = new RuntimeSurface({ sessionId: 's' });
    const oldId = 'msg_01990f4ca010abcdefghijklmn';
    const newestId = 'msg_01990f4ca020abcdefghijklmn';

    surface.seedWireMessages([
      {
        info: { id: newestId, role: 'user', sessionID: surface.rootId },
        parts: [],
      },
    ]);

    expect(surface.canAdmitMessageId(oldId)).toBe(false);
    expect(surface.canAdmitMessageId(newestId)).toBe(false);
    expect(surface.canAdmitMessageId('msg_01990f4ca020zzzzzzzzzzzzzz')).toBe(true);
    expect(surface.canAdmitMessageId('msg_01990f4ca021abcdefghijklmn')).toBe(true);
  });

  test('skips a message with nothing renderable rather than showing an empty bubble', () => {
    const surface = new RuntimeSurface({ sessionId: 's' });
    const seeded = surface.seedRestoredMessages([
      { role: 'assistant', content: [] },
      { role: 'assistant', content: [{ type: 'tool_use', name: 'bash' }] },
      { role: 'user', content: [{ type: 'text', text: 'kept' }] },
    ]);
    expect(seeded).toBe(1);
    expect(surface.transcript.page({ limit: 10, before: null }).messages).toHaveLength(1);
  });

  test('history is not replayed onto the event bus', () => {
    // A reconnecting client already has these; republishing them would arrive
    // as a burst of "new" events for messages it is already showing.
    const surface = new RuntimeSurface({ sessionId: 's' });
    const seen: string[] = [];
    surface.bus.subscribe((e: any) => seen.push(e.type), { since: null, epoch: null });
    surface.seedRestoredMessages(restored());
    expect(seen).toHaveLength(0);
  });

  test('reuses persisted wire ids and parent links after a worker restart', () => {
    const surface = new RuntimeSurface({
      sessionId: 's',
      agentName: 'build',
      resolvedModel: { providerID: 'anthropic', modelID: 'claude-sonnet' },
      workspace: '/workspace',
    });
    const userId = 'msg_01990f4ca000abcdefghijklmn';
    const assistantId = 'msg_01990f4ca001opqrstuvwxyzAB';

    surface.seedRestoredMessages([
      {
        role: 'user',
        content: [{ type: 'text', text: 'stable question' }],
        timestamp: 1,
        kortixWireMessageId: userId,
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'stable answer' }],
        timestamp: 2,
        model: 'claude-sonnet',
        provider: 'anthropic',
        usage: { input: 11, output: 7, reasoning: 2, cacheRead: 3, cacheWrite: 1 },
        kortixWireMessageId: assistantId,
        kortixParentMessageId: userId,
      },
    ]);

    const page = surface.transcript.page({ limit: 10, before: null });
    expect(page.messages.map((message) => message.info.id)).toEqual([userId, assistantId]);
    const user = page.messages[0]!.info as unknown as UserMessage;
    const assistant = page.messages[1]!.info as unknown as AssistantMessage;
    expect(user.agent).toBe('build');
    expect(user.model).toEqual({ providerID: 'anthropic', modelID: 'claude-sonnet' });
    expect(assistant.parentID).toBe(userId);
    expect(assistant.modelID).toBe('claude-sonnet');
    expect(assistant.providerID).toBe('anthropic');
    expect(assistant.mode).toBe('build');
    expect(assistant.agent).toBe('build');
    expect(assistant.path).toEqual({ cwd: '/workspace', root: '/workspace' });
    expect(assistant.cost).toBe(0);
    expect(assistant.tokens).toEqual({
      input: 11,
      output: 7,
      reasoning: 2,
      cache: { read: 3, write: 1 },
    });
    expect(surface.assistantMessagesForParent(userId)).toEqual([page.messages[1]]);
    expect(surface.latestCompletedTurnIdentity()).toEqual({
      opencodeSessionId: surface.rootId,
      messageId: userId,
      status: 'idle',
    });
    expect(surface.mintMessageId() > assistantId).toBe(true);
  });

  test('reports every completed turn identity and preserves terminal error status', () => {
    const surface = new RuntimeSurface({ sessionId: 's' });
    const firstUser = 'msg_01990f4ca000abcdefghijklmn';
    const firstAssistant = 'msg_01990f4ca001opqrstuvwxyzAB';
    const secondUser = 'msg_01990f4ca002abcdefghijklmn';
    const secondAssistant = 'msg_01990f4ca003opqrstuvwxyzAB';
    surface.seedRestoredMessages([
      {
        role: 'user',
        content: [{ type: 'text', text: 'first' }],
        timestamp: 1,
        kortixWireMessageId: firstUser,
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
        timestamp: 2,
        kortixWireMessageId: firstAssistant,
        kortixParentMessageId: firstUser,
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'second' }],
        timestamp: 3,
        kortixWireMessageId: secondUser,
      },
      {
        role: 'assistant',
        content: [],
        timestamp: 4,
        stopReason: 'error',
        errorMessage: 'provider failed',
        kortixWireMessageId: secondAssistant,
        kortixParentMessageId: secondUser,
      },
    ]);

    expect(surface.completedTurnIdentities()).toEqual([
      { opencodeSessionId: surface.rootId, messageId: firstUser, status: 'idle' },
      { opencodeSessionId: surface.rootId, messageId: secondUser, status: 'error' },
    ]);
    const failed = surface.transcript.messageById(secondAssistant)!;
    expect(failed.parts).toEqual([]);
    expect((failed.info as AssistantMessage).error).toEqual({
      name: 'UnknownError',
      data: { message: 'provider failed' },
    });
  });

  test('seeds exact queued wire envelopes without replaying them as events', () => {
    const surface = new RuntimeSurface({ sessionId: 's' });
    const seen: string[] = [];
    surface.bus.subscribe((event) => seen.push(event.type), { since: null, epoch: null });
    const id = 'msg_01990f4ca000abcdefghijklmn';
    const message = {
      info: { id, role: 'user', sessionID: surface.rootId, time: { created: 123 } },
      parts: [
        { id: `${id}-p0`, messageID: id, sessionID: surface.rootId, type: 'text', text: 'queued' },
      ],
    };

    expect(surface.seedWireMessages([message])).toBe(1);
    expect(surface.transcript.messageById(id)).toEqual(message);
    expect(seen).toEqual([]);
  });

  test('replaces rejected live messages and publishes client convergence events', () => {
    const surface = new RuntimeSurface({ sessionId: 's' });
    const userId = 'msg_01990f4ca000abcdefghijklmn';
    const staleAssistantId = 'msg_01990f4ca001opqrstuvwxyzAB';
    const durableAssistantId = 'msg_01990f4ca002CDEFGHIJKLMNOP';
    const user = {
      role: 'user',
      content: [{ type: 'text', text: 'question' }],
      timestamp: 1,
      kortixWireMessageId: userId,
    };
    surface.seedRestoredMessages([
      user,
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'rejected answer' }],
        timestamp: 2,
        kortixWireMessageId: staleAssistantId,
        kortixParentMessageId: userId,
      },
    ]);
    const seen: Array<{ type: string; payload: unknown }> = [];
    surface.bus.subscribe((event) => seen.push(event), { since: null, epoch: null });

    surface.replaceDurableMessages(
      [
        user,
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'durable answer' }],
          timestamp: 3,
          kortixWireMessageId: durableAssistantId,
          kortixParentMessageId: userId,
        },
      ],
      [],
    );

    expect(JSON.stringify(surface.transcript.page({ limit: 10, before: null }).messages)).toContain(
      'durable answer',
    );
    expect(
      JSON.stringify(surface.transcript.page({ limit: 10, before: null }).messages),
    ).not.toContain('rejected answer');
    expect(seen.map((event) => event.type)).toEqual([
      'message.removed',
      'message.updated',
      'message.part.updated',
    ]);
    expect((seen[0]!.payload as { messageID: string }).messageID).toBe(staleAssistantId);
    expect(
      (
        seen[1]!.payload as {
          info: { id: string };
        }
      ).info.id,
    ).toBe(durableAssistantId);
  });

  test('restores durable Pi thinking as a complete v2 reasoning part', () => {
    const surface = new RuntimeSurface({ sessionId: 's' });
    const userId = 'msg_01990f4ca000abcdefghijklmn';
    const assistantId = 'msg_01990f4ca001opqrstuvwxyzAB';

    surface.seedRestoredMessages([
      {
        role: 'user',
        content: [{ type: 'text', text: 'reason' }],
        timestamp: 1,
        kortixWireMessageId: userId,
      },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'private chain' },
          { type: 'text', text: 'public answer' },
        ],
        timestamp: 2,
        kortixWireMessageId: assistantId,
        kortixParentMessageId: userId,
      },
    ]);

    const message = surface.transcript.messageById(assistantId)!;
    expect(message.parts[0]).toMatchObject({
      id: `${assistantId}-p0`,
      messageID: assistantId,
      sessionID: surface.rootId,
      type: 'reasoning',
      text: 'private chain',
      time: { start: 2, end: 2 },
    });
    expect(message.parts[1]).toMatchObject({ type: 'text', text: 'public answer' });
  });
});

// Verbatim from the durable log of a real pi.kortix.com turn (session
// 3069ad04, "create number.txt containing 4417").
const toolTurn = [
  { role: 'user', content: [{ type: 'text', text: 'create number.txt with 4417' }], timestamp: 1 },
  {
    role: 'assistant',
    timestamp: 2,
    content: [
      {
        id: 'call_j4mbycnp9oK0SkGqZx39VeDn',
        name: 'write',
        type: 'toolCall',
        arguments: { path: 'number.txt', content: '4417' },
      },
    ],
  },
  {
    role: 'toolResult',
    timestamp: 3,
    isError: false,
    toolName: 'write',
    toolCallId: 'call_j4mbycnp9oK0SkGqZx39VeDn',
    content: [{ type: 'text', text: 'Successfully wrote 4 bytes to number.txt' }],
  },
  { role: 'assistant', content: [{ type: 'text', text: 'SAVED' }], timestamp: 4 },
];

describe('RuntimeSurface.seedRestoredMessages — tool calls', () => {
  test('a call and its result restore as ONE completed tool part, not two bubbles', () => {
    const surface = new RuntimeSurface({ sessionId: 's' });
    // 3 messages, not 4: the toolResult folds onto the call it answers.
    expect(surface.seedRestoredMessages(toolTurn)).toBe(3);

    const page = surface.transcript.page({ limit: 50, before: null });
    expect(page.messages).toHaveLength(3);
    const [, call, answer] = page.messages;

    const part = call!.parts[0] as any;
    expect(part.type).toBe('tool');
    expect(part.tool).toBe('write');
    expect(part.state.status).toBe('completed');
    expect(part.state.input).toEqual({ path: 'number.txt', content: '4417' });
    expect(part.state.output).toBe('Successfully wrote 4 bytes to number.txt');
    expect((part as ToolPart).state).toMatchObject({
      status: 'completed',
      title: 'write',
      metadata: {},
      time: { start: 2, end: 3 },
    });

    // The result text is NOT something the assistant said. Before this it was
    // seeded as its own text bubble and the write card vanished.
    expect(answer!.parts.map((p: any) => p.text).join('')).toBe('SAVED');
    expect(
      page.messages.some((m) => m.parts.some((p: any) => p.text?.startsWith('Successfully'))),
    ).toBe(false);
  });

  test('a call whose result never came stays running — an interrupted turn is not a completed one', () => {
    const surface = new RuntimeSurface({ sessionId: 's' });
    expect(surface.seedRestoredMessages(toolTurn.slice(0, 2))).toBe(2);
    const page = surface.transcript.page({ limit: 10, before: null });
    expect((page.messages[1]!.parts[0] as any).state.status).toBe('running');
  });

  test('an orphan result is dropped rather than shown as a bare string', () => {
    // Its call fell outside the restored window; alone it has nothing to attach to.
    const surface = new RuntimeSurface({ sessionId: 's' });
    expect(surface.seedRestoredMessages([toolTurn[2]!])).toBe(0);
    expect(surface.transcript.page({ limit: 10, before: null }).messages).toHaveLength(0);
  });
});

/**
 * Drive one request through `handle()` with a fake node req/res pair, so the
 * routing and auth are exercised exactly as the server does.
 */
function callSurface(surface: RuntimeSurface, method: string, path: string, token?: string) {
  const url = new URL(`http://127.0.0.1:8000${path}`);
  const req = { method, headers: token ? { authorization: `Bearer ${token}` } : {} } as any;
  let status = 0;
  let body = '';
  const res = {
    writeHead(code: number) {
      status = code;
      return res;
    },
    end(chunk?: string) {
      body = chunk ?? '';
      return res;
    },
  } as any;
  const handled = surface.handle(req, res, url);
  return { handled, status, body };
}

/** The RAW root, with no `/kortix/opencode` prefix — what the SDK actually calls. */
function callRaw(surface: RuntimeSurface, method: string, path: string, token?: string) {
  const url = new URL(`http://127.0.0.1:8000${path}`);
  const req = { method, headers: token ? { authorization: `Bearer ${token}` } : {} } as any;
  let status = 0;
  let body = '';
  let headers: Record<string, string> = {};
  const res = {
    writeHead(code: number, nextHeaders?: Record<string, string>) {
      status = code;
      headers = nextHeaders ?? {};
      return res;
    },
    end(chunk?: string) {
      body = chunk ?? '';
      return res;
    },
  } as any;
  const handled = surface.handleRawSessionList(req, res, url);
  return { handled, status, body, headers };
}

describe('RuntimeSurface raw message reads', () => {
  test('projects only the pinned model reasoning levels through raw and state config', () => {
    const surface = new RuntimeSurface({
      sessionId: 'reasoning-session', token: 'tok', agentName: 'reviewer',
      resolvedModel: { providerID: 'kortix', modelID: 'openai/pinned-model' },
      reasoningVariants: ['none', 'low', 'high'],
      agents: { reviewer: { variant: 'low' } },
    });
    const expected = { kortix: { models: {
      'openai/pinned-model': { variants: { none: {}, low: {}, high: {} } },
    } } };
    for (const path of ['/config', '/global/config']) {
      const response = callRaw(surface, 'GET', path, 'tok');
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body).provider).toEqual(expected);
      expect(JSON.parse(response.body).agent.reviewer.variant).toBe('low');
    }
    const response = callSurface(surface, 'GET', '/kortix/opencode/state', 'tok');
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).config.value.provider).toEqual(expected);
  });

  test('does not invent reasoning choices when capabilities are absent', () => {
    const surface = new RuntimeSurface({
      sessionId: 'reasoning-session', token: 'tok',
      resolvedModel: { providerID: 'kortix', modelID: 'plain-model' },
      reasoningVariants: [],
    });
    const config = JSON.parse(callRaw(surface, 'GET', '/config', 'tok').body);
    expect(config.provider.kortix.models['plain-model'].variants).toEqual({});
  });

  test('publishes one gateway model identity in agent and config state', () => {
    const model = { providerID: 'kortix', modelID: 'anthropic/claude-sonnet-4.5' };
    const surface = new RuntimeSurface({
      sessionId: 'session-1',
      token: 'tok',
      agentName: 'build',
      agents: { build: { model: 'anthropic/claude-sonnet-4.5' } },
      defaultModel: 'kortix/anthropic/claude-sonnet-4.5',
      resolvedModel: model,
    });

    const response = callSurface(surface, 'GET', '/kortix/opencode/state', 'tok');
    const state = JSON.parse(response.body) as {
      agents: { value: Array<{ name: string; model: typeof model }> };
      config: { value: { model: string | null } };
    };

    expect(response.status).toBe(200);
    expect(state.agents.value).toEqual([expect.objectContaining({ name: 'build', model })]);
    expect(state.config.value.model).toBe('kortix/anthropic/claude-sonnet-4.5');
  });

  test('serves the project identity required by the OpenCode v2 session contract', () => {
    const surface = new RuntimeSurface({
      sessionId: 'session-1',
      projectId: 'project-1',
      token: 'tok',
    });

    const response = callRaw(surface, 'GET', '/session', 'tok');
    const sessions = JSON.parse(response.body) as Session[];

    expect(response.status).toBe(200);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.slug).toBe(sessions[0]!.id);
    expect(sessions[0]!.projectID).toBe('project-1');
  });

  test('serves the durable transcript through the OpenCode message-list route', () => {
    const surface = new RuntimeSurface({ sessionId: 's', token: 'tok' });
    surface.seedRestoredMessages(restored());

    const response = callRaw(
      surface,
      'GET',
      `/session/${surface.rootId}/message?directory=%2Fworkspace&limit=2`,
      'tok',
    );

    expect(response.handled).toBe(true);
    expect(response.status).toBe(200);
    const messages = JSON.parse(response.body) as Array<{
      info: { id: string; role: string };
      parts: Array<{ text?: string }>;
    }>;
    expect(messages).toHaveLength(2);
    expect(messages.map((message) => message.info.role)).toEqual(['user', 'assistant']);
    expect(
      messages.map((message) => message.parts.map((part) => part.text ?? '').join('')),
    ).toEqual(['second question', 'second answer']);
  });

  test('serves one message by id and rejects an unknown message', () => {
    const surface = new RuntimeSurface({ sessionId: 's', token: 'tok' });
    surface.seedRestoredMessages(restored());
    const message = surface.transcript.page({ limit: 1, before: null }).messages[0]!;

    const found = callRaw(
      surface,
      'GET',
      `/session/${surface.rootId}/message/${message.info.id}`,
      'tok',
    );
    expect(found.handled).toBe(true);
    expect(found.status).toBe(200);
    expect(JSON.parse(found.body)).toEqual(message);

    const missing = callRaw(
      surface,
      'GET',
      `/session/${surface.rootId}/message/msg_missing`,
      'tok',
    );
    expect(missing.handled).toBe(true);
    expect(missing.status).toBe(404);
  });

  test('does not expose transcript bytes without runtime authentication', () => {
    const surface = new RuntimeSurface({ sessionId: 's', token: 'tok' });
    surface.seedRestoredMessages(restored());

    const response = callRaw(surface, 'GET', `/session/${surface.rootId}/message`);

    expect(response.handled).toBe(true);
    expect(response.status).toBe(401);
  });

  test('paginates backward with before and exposes the next cursor', () => {
    const surface = new RuntimeSurface({ sessionId: 's', token: 'tok' });
    surface.seedRestoredMessages(restored());

    const latest = callRaw(surface, 'GET', `/session/${surface.rootId}/message?limit=2`, 'tok');
    const latestMessages = JSON.parse(latest.body) as Array<{
      info: { id: string; time: { created: number } };
    }>;
    const cursor = latest.headers['x-next-cursor'];
    expect(latestMessages).toHaveLength(2);
    expect(JSON.parse(Buffer.from(cursor!, 'base64url').toString('utf8'))).toEqual({
      id: latestMessages[0]!.info.id,
      time: latestMessages[0]!.info.time.created,
    });
    expect(latest.headers['access-control-expose-headers']).toBe('Link, X-Next-Cursor');
    expect(latest.headers.link).toContain(`before=${encodeURIComponent(cursor!)}`);
    expect(latest.headers.link).toStartWith('</session/');
    expect(latest.headers.link).not.toContain('http://x');

    const older = callRaw(
      surface,
      'GET',
      `/session/${surface.rootId}/message?limit=2&before=${encodeURIComponent(cursor!)}`,
      'tok',
    );
    const olderMessages = JSON.parse(older.body) as Array<{ info: { id: string } }>;
    expect(olderMessages).toHaveLength(2);
    expect(older.headers['x-next-cursor']).toBeUndefined();
    expect(
      new Set([...olderMessages, ...latestMessages].map((message) => message.info.id)).size,
    ).toBe(4);
  });

  test('rejects a before cursor without a positive limit and rejects malformed cursors', () => {
    const surface = new RuntimeSurface({ sessionId: 's', token: 'tok' });
    surface.seedRestoredMessages(restored());

    expect(
      callRaw(surface, 'GET', `/session/${surface.rootId}/message?before=not-a-cursor`, 'tok')
        .status,
    ).toBe(400);
    expect(
      callRaw(
        surface,
        'GET',
        `/session/${surface.rootId}/message?limit=2&before=not-a-cursor`,
        'tok',
      ).status,
    ).toBe(400);
  });

  test('deletes queued messages but refuses a non-durable part mutation', () => {
    const states = new Map<string, 'queued' | 'running'>();
    const surface = new RuntimeSurface({
      sessionId: 's',
      token: 'tok',
      onDeleteMessage: (messageId) => {
        const state = states.get(messageId);
        if (!state) return 'missing';
        if (state === 'running') return 'running';
        states.delete(messageId);
        return 'deleted';
      },
    });
    const queued = surface.mintMessageId();
    states.set(queued, 'queued');
    surface.publishWire({
      type: 'message.updated',
      properties: {
        sessionID: surface.rootId,
        info: {
          id: queued,
          role: 'user',
          sessionID: surface.rootId,
          time: { created: Date.now() },
        },
      },
    });
    surface.publishWire({
      type: 'message.part.updated',
      properties: {
        sessionID: surface.rootId,
        part: {
          id: `${queued}-p0`,
          messageID: queued,
          sessionID: surface.rootId,
          type: 'text',
          text: 'later',
        },
      },
    });

    const deleted = callRaw(
      surface,
      'DELETE',
      `/session/${surface.rootId}/message/${queued}`,
      'tok',
    );
    expect(deleted.status).toBe(200);
    expect(JSON.parse(deleted.body)).toBe(true);
    expect(surface.transcript.messageById(queued)).toBeNull();

    const partQueued = surface.mintMessageId();
    states.set(partQueued, 'queued');
    surface.publishWire({
      type: 'message.updated',
      properties: {
        sessionID: surface.rootId,
        info: {
          id: partQueued,
          role: 'user',
          sessionID: surface.rootId,
          time: { created: Date.now() },
        },
      },
    });
    surface.publishWire({
      type: 'message.part.updated',
      properties: {
        sessionID: surface.rootId,
        part: {
          id: `${partQueued}-p0`,
          messageID: partQueued,
          sessionID: surface.rootId,
          type: 'text',
          text: 'later',
        },
      },
    });
    const partDeleted = callRaw(
      surface,
      'DELETE',
      `/session/${surface.rootId}/message/${partQueued}/part/${partQueued}-p0`,
      'tok',
    );
    expect(partDeleted.status).toBe(409);
    expect(surface.transcript.messageById(partQueued)?.parts).toHaveLength(1);
    expect(states.get(partQueued)).toBe('queued');
  });

  test('does not report durable history deleted while its bytes remain', () => {
    const surface = new RuntimeSurface({
      sessionId: 's',
      token: 'tok',
      onDeleteMessage: () => 'missing',
    });
    surface.seedRestoredMessages(restored());
    const message = surface.transcript.page({ limit: 1, before: null }).messages[0]!;

    const whole = callRaw(
      surface,
      'DELETE',
      `/session/${surface.rootId}/message/${message.info.id}`,
      'tok',
    );
    const part = callRaw(
      surface,
      'DELETE',
      `/session/${surface.rootId}/message/${message.info.id}/part/${message.parts[0]!.id}`,
      'tok',
    );

    expect(whole.status).toBe(409);
    expect(part.status).toBe(409);
    expect(surface.transcript.messageById(String(message.info.id))).toEqual(message);
  });

  test('does not delete visible durable history without a deletion owner', () => {
    const surface = new RuntimeSurface({ sessionId: 's', token: 'tok' });
    surface.seedRestoredMessages(restored());
    const message = surface.transcript.page({ limit: 1, before: null }).messages[0]!;

    const response = callRaw(
      surface,
      'DELETE',
      `/session/${surface.rootId}/message/${message.info.id}`,
      'tok',
    );

    expect(response.status).toBe(409);
    expect(surface.transcript.messageById(String(message.info.id))).toEqual(message);
  });

  test('refuses deletion after a queued turn reaches the model', () => {
    const surface = new RuntimeSurface({
      sessionId: 's',
      token: 'tok',
      onDeleteMessage: () => 'running',
    });
    const messageId = surface.mintMessageId();
    surface.publishWire({
      type: 'message.updated',
      properties: {
        sessionID: surface.rootId,
        info: {
          id: messageId,
          role: 'user',
          sessionID: surface.rootId,
          time: { created: Date.now() },
        },
      },
    });

    const response = callRaw(
      surface,
      'DELETE',
      `/session/${surface.rootId}/message/${messageId}`,
      'tok',
    );
    expect(response.status).toBe(409);
    expect(surface.transcript.messageById(messageId)).not.toBeNull();
  });
});

/**
 * Reported 2026-08-29 on pi: pressing Stop showed "Interrupted" in the
 * transcript and the answer kept streaming.
 *
 * The client's Stop is `session.abort({ sessionID })` on the OpenCode runtime
 * client, which is `POST session/:id/abort`. This surface implemented exactly
 * four routes — `state`, `messages/:id`, `session/:id` (GET) and `events` — so
 * the abort fell through to the catch-all 404 (`no pi handler for
 * /kortix/opencode/…`). Nothing ever reached the agent, which kept generating,
 * while the UI applied its optimistic abort receipt and said "Interrupted".
 *
 * `Agent.abort()` exists in pi-agent-core; only the route was missing.
 */
describe('RuntimeSurface session abort', () => {
  test('routes POST session/:id/abort to the agent', () => {
    let aborted = 0;
    const surface = new RuntimeSurface({
      sessionId: 's',
      token: 'tok',
      onAbort: () => {
        aborted += 1;
      },
    });
    const res = callSurface(
      surface,
      'POST',
      `/kortix/opencode/session/${surface.rootId}/abort`,
      'tok',
    );
    expect(res.status).toBe(200);
    expect(aborted).toBe(1);
  });

  test('refuses an unknown session rather than aborting the wrong run', () => {
    let aborted = 0;
    const surface = new RuntimeSurface({
      sessionId: 's',
      token: 'tok',
      onAbort: () => {
        aborted += 1;
      },
    });
    const res = callSurface(surface, 'POST', '/kortix/opencode/session/not-this-one/abort', 'tok');
    expect(res.status).toBe(404);
    expect(aborted).toBe(0);
  });

  test('still requires auth — an abort is a state change', () => {
    let aborted = 0;
    const surface = new RuntimeSurface({
      sessionId: 's',
      token: 'tok',
      onAbort: () => {
        aborted += 1;
      },
    });
    const res = callSurface(
      surface,
      'POST',
      `/kortix/opencode/session/${surface.rootId}/abort`,
      'wrong',
    );
    expect(res.status).toBe(401);
    expect(aborted).toBe(0);
  });

  test('is harmless with no run in flight and no handler wired', () => {
    // The UI can send Stop against a stale open turn row, and the bench runs
    // this surface with no agent at all. Both must be a no-op, not an error.
    const surface = new RuntimeSurface({ sessionId: 's', token: 'tok' });
    const res = callSurface(
      surface,
      'POST',
      `/kortix/opencode/session/${surface.rootId}/abort`,
      'tok',
    );
    expect(res.status).toBe(200);
  });

  // THE PATH THE PRODUCT USES. The SDK builds its OpenCode client with
  // `baseUrl = <backend>/p/<externalId>/8000` (getClientForUrl), so
  // `session.abort()` posts to the RAW root — no `/kortix/opencode` prefix.
  // Every test above passes against the prefixed route, which is exactly how
  // Stop shipped broken: the prefixed handler existed, the raw one did not, and
  // the POST fell through to the worker's catch-all 404 while the UI showed
  // "Interrupted" from its own optimistic receipt.
  describe('the RAW path the SDK calls', () => {
    test('POST /session/:id/abort (no prefix) reaches the agent', () => {
      let aborted = 0;
      const surface = new RuntimeSurface({
        sessionId: 's',
        token: 'tok',
        onAbort: () => {
          aborted += 1;
        },
      });
      const res = callRaw(surface, 'POST', `/session/${surface.rootId}/abort`, 'tok');
      expect(res.handled).toBe(true);
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toBe(true);
      expect(aborted).toBe(1);
    });

    test('refuses an unknown session rather than aborting the wrong run', () => {
      let aborted = 0;
      const surface = new RuntimeSurface({
        sessionId: 's',
        token: 'tok',
        onAbort: () => {
          aborted += 1;
        },
      });
      const res = callRaw(surface, 'POST', '/session/not-this-one/abort', 'tok');
      expect(res.status).toBe(404);
      expect(aborted).toBe(0);
    });

    test('still requires auth — an abort is a state change', () => {
      let aborted = 0;
      const surface = new RuntimeSurface({
        sessionId: 's',
        token: 'tok',
        onAbort: () => {
          aborted += 1;
        },
      });
      const res = callRaw(surface, 'POST', `/session/${surface.rootId}/abort`, 'wrong');
      expect(res.status).toBe(401);
      expect(aborted).toBe(0);
    });

    test('is harmless with no handler wired', () => {
      const surface = new RuntimeSurface({ sessionId: 's', token: 'tok' });
      expect(callRaw(surface, 'POST', `/session/${surface.rootId}/abort`, 'tok').status).toBe(200);
    });

    test('GET /session/:id still returns the session object', () => {
      const surface = new RuntimeSurface({ sessionId: 's', token: 'tok' });
      const res = callRaw(surface, 'GET', `/session/${surface.rootId}`, 'tok');
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body).id).toBe(surface.rootId);
    });
  });

  test('GET session/:id still returns the session, not an abort', () => {
    // The abort match must not swallow the existing read route.
    const surface = new RuntimeSurface({ sessionId: 's', token: 'tok' });
    const res = callSurface(surface, 'GET', `/kortix/opencode/session/${surface.rootId}`, 'tok');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).id).toBe(surface.rootId);
  });
});

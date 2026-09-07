import { describe, expect, test } from 'bun:test';
import type { AssistantMessageEvent as PiAssistantMessageEvent } from '@earendil-works/pi-ai';
import type { AssistantMessage, ReasoningPart, ToolPart } from '@opencode-ai/sdk/v2';
import { RuntimeSurface } from './runtime-surface.ts';
import { ChatEventAdapter } from './chat-events.ts';

function adapterFor(surface: RuntimeSurface) {
  return new ChatEventAdapter({ sessionID: surface.rootId });
}

function textDelta(delta: string, contentIndex = 0) {
  return {
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta, contentIndex },
  } as any;
}

function piTerminalEvent(
  event:
    | Omit<Extract<PiAssistantMessageEvent, { type: 'text_end' }>, 'partial'>
    | Omit<Extract<PiAssistantMessageEvent, { type: 'thinking_end' }>, 'partial'>,
) {
  return {
    type: 'message_update',
    assistantMessageEvent: { ...event, partial: {} as never },
  } as any;
}

describe('pi streams as deltas, not only snapshots', () => {
  // pi's documented contract is `message_update -> assistantMessageEvent
  // .text_delta.delta`. We used to discard that delta and republish the whole
  // accumulated string as a cumulative `message.part.updated`. Correct, but it
  // is the SNAPSHOT path, and the web client only re-renders eagerly off
  // `message.part.delta` — so a pi answer landed as one lump at the end
  // (measured: 183 frames streamed, browser painted once at 94% complete).
  test('a text_delta yields a bus delta AND a transcript-only snapshot', () => {
    const surface = new RuntimeSurface({ sessionId: 's' });
    const adapter = adapterFor(surface);
    const frames = adapter.translate(textDelta('Hello'));

    const delta = frames.find((f: any) => f.type === 'message.part.delta') as any;
    const snap = frames.find((f: any) => f.type === 'message.part.updated') as any;
    expect(delta).toBeDefined();
    expect(snap).toBeDefined();
    expect(snap.properties.time).toEqual(expect.any(Number));
    expect(delta.properties.delta).toBe('Hello');
    expect(delta.properties.field).toBe('text');
    expect(delta.properties.partID).toBe(snap.properties.part.id);
    // The snapshot must never reach the bus beside its own delta.
    expect(snap.transcriptOnly).toBe(true);
    expect(delta.transcriptOnly).toBeUndefined();
  });

  test('the two carry the SAME text — append vs replace, never both on the bus', () => {
    const surface = new RuntimeSurface({ sessionId: 's' });
    const adapter = adapterFor(surface);
    // The real order: the assistant message is created first, then chunks.
    for (const f of adapter.translate({
      type: 'message_start',
      message: { role: 'assistant' },
    } as any)) {
      surface.publishWire(f);
    }
    const seen: string[] = [];
    surface.bus.subscribe((e: any) => seen.push(e.type), { since: null, epoch: null });

    for (const chunk of ['The ', 'sea ', 'is ', 'wide.']) {
      for (const f of adapter.translate(textDelta(chunk))) surface.publishWire(f);
    }

    // Every chunk reached the bus exactly once, as a delta.
    expect(seen.filter((t) => t === 'message.part.delta')).toHaveLength(4);
    expect(seen.filter((t) => t === 'message.part.updated')).toHaveLength(0);

    // The transcript still holds the whole string: REST reads and `since=`
    // resync must not depend on replaying deltas.
    const page = surface.transcript.page({ limit: 10, before: null });
    const text = page.messages
      .flatMap((m: any) => m.parts)
      .map((p: any) => p.text)
      .join('');
    expect(text).toBe('The sea is wide.');
  });

  test('a chunk with no delta (text_start/text_end) publishes normally', () => {
    const surface = new RuntimeSurface({ sessionId: 's' });
    const adapter = adapterFor(surface);
    const frames = adapter.translate(
      piTerminalEvent({ type: 'text_end', content: 'done', contentIndex: 0 }),
    );
    const snap = frames.find((f: any) => f.type === 'message.part.updated') as any;
    // No append to duplicate, so this one goes to the bus — and it repairs any
    // drift, since upsertPart accepts prefix growth.
    expect(snap.transcriptOnly).toBeUndefined();
    expect(frames.some((f: any) => f.type === 'message.part.delta')).toBe(false);
    expect(snap.properties.part.text).toBe('done');
  });

  test('reasoning streams the same way', () => {
    const surface = new RuntimeSurface({ sessionId: 's' });
    const adapter = adapterFor(surface);
    adapter.translate({ type: 'message_start', message: { role: 'assistant' } } as any);
    const started = adapter.translate({
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_start', thinking: '', contentIndex: 0 },
    } as any);
    const frames = adapter.translate({
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', delta: 'hmm', contentIndex: 0 },
    } as any);
    const ended = adapter.translate({
      ...piTerminalEvent({ type: 'thinking_end', content: 'hmm', contentIndex: 0 }),
    });
    const delta = frames.find((f: any) => f.type === 'message.part.delta') as any;
    const snap = frames.find((f: any) => f.type === 'message.part.updated') as any;
    const startPart = started[0]!.properties.part as unknown as ReasoningPart;
    const endPart = ended[0]!.properties.part as unknown as ReasoningPart;
    expect(delta?.properties.delta).toBe('hmm');
    expect(snap?.properties.part.type).toBe('reasoning');
    expect(snap?.transcriptOnly).toBe(true);
    expect(startPart.time.start).toEqual(expect.any(Number));
    expect(startPart.time.end).toBeUndefined();
    expect(endPart.time.start).toBe(startPart.time.start);
    expect(endPart.time.end).toEqual(expect.any(Number));
    expect(endPart.text).toBe('hmm');
  });

  test('assistant and tool start timestamps remain stable through terminal updates', () => {
    const clock = [100, 200, 300, 400, 500][Symbol.iterator]();
    const adapter = new ChatEventAdapter({
      sessionID: 'ses_pi_1',
      now: () => clock.next().value ?? 999,
    });

    const [messageStarted] = adapter.translate({
      type: 'message_start',
      message: { role: 'assistant' },
    } as any);
    const [toolStarted] = adapter.translate({
      type: 'tool_execution_start',
      toolCallId: 'call_1',
      toolName: 'bash',
      args: { command: 'pwd' },
    } as any);
    const [toolUpdated] = adapter.translate({
      type: 'tool_execution_update',
      toolCallId: 'call_1',
      toolName: 'bash',
      args: { command: 'pwd' },
      partialResult: {},
    } as any);
    const [toolEnded] = adapter.translate({
      type: 'tool_execution_end',
      toolCallId: 'call_1',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: '/workspace' }] },
      isError: false,
    } as any);
    const [messageEnded] = adapter.translate({
      type: 'message_end',
      message: { role: 'assistant' },
    } as any);

    expect((messageStarted!.properties.info as any).time).toEqual({ created: 100 });
    expect((messageEnded!.properties.info as any).time).toEqual({ created: 100, completed: 400 });
    expect(((toolStarted!.properties.part as ToolPart).state as any).time).toEqual({ start: 200 });
    expect(((toolUpdated!.properties.part as ToolPart).state as any).time).toEqual({ start: 200 });
    expect(((toolEnded!.properties.part as ToolPart).state as any).time).toEqual({
      start: 200,
      end: 300,
    });
  });

  test('completed tools include every required OpenCode v2 state field', () => {
    const adapter = new ChatEventAdapter({ sessionID: 'ses_pi_1' });
    adapter.translate({ type: 'message_start', message: { role: 'assistant' } } as any);
    adapter.translate({
      type: 'tool_execution_start',
      toolCallId: 'call_1',
      toolName: 'bash',
      args: { command: 'pwd' },
    } as any);
    const [completed] = adapter.translate({
      type: 'tool_execution_end',
      toolCallId: 'call_1',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: '/workspace' }] },
      isError: false,
    } as any);

    const part = completed!.properties.part as unknown as ToolPart;
    expect(completed!.properties.time).toEqual(expect.any(Number));
    expect(part.state).toMatchObject({
      status: 'completed',
      input: { command: 'pwd' },
      output: '/workspace',
      title: 'bash',
      metadata: {},
      time: { start: expect.any(Number), end: expect.any(Number) },
    });
  });
});

describe('assistant messages identify the user turn they answer', () => {
  test('uses the compiled gateway model instead of the provider transport identity', () => {
    const adapter = new ChatEventAdapter({
      sessionID: 'ses_pi_1',
      model: { providerID: 'kortix', modelID: 'anthropic/claude-sonnet-4.5' },
    });
    const started = adapter.translate({
      type: 'message_start',
      message: { role: 'assistant', model: 'claude-sonnet-4.5', provider: 'openrouter' },
    } as any);
    const ended = adapter.translate({
      type: 'message_end',
      message: { role: 'assistant', model: 'claude-sonnet-4.5', provider: 'openrouter' },
    } as any);

    for (const event of [started[0], ended[0]]) {
      expect((event!.properties.info as AssistantMessage).providerID).toBe('kortix');
      expect((event!.properties.info as AssistantMessage).modelID).toBe(
        'anthropic/claude-sonnet-4.5',
      );
    }
  });

  test('maps Pi accounting into the OpenCode v2 assistant contract', () => {
    const adapter = new ChatEventAdapter({
      sessionID: 'ses_pi_1',
      parentMessageId: () => 'msg_user_1',
      agent: 'build',
      mode: 'build',
      workspace: '/workspace',
    });
    adapter.translate({
      type: 'message_start',
      message: { role: 'assistant', model: 'claude', provider: 'anthropic' },
    } as any);

    const completed = adapter.translate({
      type: 'message_end',
      message: {
        role: 'assistant',
        model: 'claude',
        provider: 'anthropic',
        usage: {
          input: 11,
          output: 7,
          reasoning: 3,
          cacheRead: 5,
          cacheWrite: 2,
          totalTokens: 28,
          cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
        },
      },
    } as any);
    const info = (completed[0] as unknown as { properties: { info: AssistantMessage } }).properties
      .info;

    expect(info.mode).toBe('build');
    expect(info.path).toEqual({ cwd: '/workspace', root: '/workspace' });
    expect(info.cost).toBe(0.33);
    expect(info.tokens).toEqual({
      input: 11,
      output: 7,
      reasoning: 3,
      cache: { read: 5, write: 2 },
    });
    expect(Object.keys(info.tokens).sort()).toEqual(['cache', 'input', 'output', 'reasoning']);
  });

  test('message start and completion carry the active user message as parentID', () => {
    let parentID: string | null = 'msg_user_1';
    const adapter = new ChatEventAdapter({
      sessionID: 'ses_pi_1',
      parentMessageId: () => parentID,
    });

    const started = adapter.translate({
      type: 'message_start',
      message: { role: 'assistant' },
    } as any);
    parentID = 'msg_user_2';
    const completed = adapter.translate({
      type: 'message_end',
      message: { role: 'assistant' },
    } as any);

    expect((started[0] as any).properties.info.parentID).toBe('msg_user_1');
    expect((completed[0] as any).properties.info.parentID).toBe('msg_user_1');
  });

  test('persists the assistant wire identity on the Pi message', () => {
    const adapter = new ChatEventAdapter({
      sessionID: 'ses_pi_1',
      messageId: () => 'msg_assistant_1',
      parentMessageId: () => 'msg_user_1',
    });
    adapter.translate({ type: 'message_start', message: { role: 'assistant' } } as any);
    const message: Record<string, unknown> = { role: 'assistant' };

    adapter.translate({ type: 'message_end', message } as any);

    expect(message.kortixWireMessageId).toBe('msg_assistant_1');
    expect(message.kortixParentMessageId).toBe('msg_user_1');
  });

  test.each([
    ['aborted', 'MessageAbortedError', 'stopped by user'],
    ['error', 'UnknownError', 'provider failed'],
  ] as const)('persists %s as a v2 assistant error', (stopReason, name, errorMessage) => {
    const adapter = new ChatEventAdapter({
      sessionID: 'ses_pi_1',
      parentMessageId: () => 'msg_user_1',
    });
    adapter.translate({ type: 'message_start', message: { role: 'assistant' } } as any);

    const completed = adapter.translate({
      type: 'message_end',
      message: {
        role: 'assistant',
        model: 'claude',
        provider: 'anthropic',
        stopReason,
        errorMessage,
      },
    } as any);
    const info = completed[0]!.properties.info as unknown as AssistantMessage;

    expect(info.error).toEqual({ name, data: { message: errorMessage } });
    if (stopReason === 'error') {
      expect(completed[1]!.properties.error).toEqual(info.error);
    }
  });

  test('persists a length stop as the OpenCode output-limit error', () => {
    const adapter = new ChatEventAdapter({
      sessionID: 'ses_pi_1',
      parentMessageId: () => 'msg_user_1',
    });
    adapter.translate({ type: 'message_start', message: { role: 'assistant' } } as any);

    const completed = adapter.translate({
      type: 'message_end',
      message: {
        role: 'assistant',
        model: 'claude',
        provider: 'anthropic',
        stopReason: 'length',
      },
    } as any);
    const info = completed[0]!.properties.info as unknown as AssistantMessage;

    expect(info.error).toEqual({ name: 'MessageOutputLengthError', data: {} });
    expect(completed[1]!.properties.error).toEqual(info.error);
  });
});

/**
 * The status word this surface emits must be one OpenCode defines.
 *
 * `SessionStatus` in @opencode-ai/sdk is exactly `idle | busy | retry`. The
 * adapter emitted `{type:'running'}`, which is none of them. Every consumer
 * that switches on the union therefore fell to its default branch — the SDK's
 * `buildWorkingInputs` read it as IDLE, so for the whole of a pi turn the
 * working indicator and the Stop button were hidden while the agent generated.
 *
 * The wire format is not ours to invent: this adapter exists to make pi look
 * like OpenCode, so an unknown word is a bug even when a tolerant consumer
 * happens to cope.
 */
describe('session.status uses OpenCode’s canonical vocabulary', () => {
  const OPENCODE_STATUSES = new Set(['idle', 'busy', 'retry']);

  test('agent_start reports busy, not an invented word', () => {
    const adapter = new ChatEventAdapter({ sessionId: 's' } as never);
    const wires = adapter.translate({ type: 'agent_start' });
    const status = wires.find((w: any) => w.type === 'session.status');
    expect(status).toBeDefined();
    expect((status as any).properties.status.type).toBe('busy');
  });

  test('every session.status this adapter can emit is in the union', () => {
    const adapter = new ChatEventAdapter({ sessionId: 's' } as never);
    const emitted = [
      ...adapter.translate({ type: 'agent_start' }),
      ...adapter.translate({ type: 'agent_end' }),
    ].filter((w: any) => w.type === 'session.status');
    expect(emitted.length).toBeGreaterThan(0);
    for (const w of emitted) {
      expect(OPENCODE_STATUSES.has((w as any).properties.status.type)).toBe(true);
    }
  });
});

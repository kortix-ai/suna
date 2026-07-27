import { describe, expect, test } from 'bun:test';

import { createAcpSessionController, type AcpSessionClient } from './session-controller';
import { AcpTransportError, type AcpEnvelope, type AcpStreamEvent } from './types';

function harness() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let emit: ((event: AcpStreamEvent) => void) | null = null;
  let emitError: ((error: unknown) => void) | null = null;
  const client: AcpSessionClient = {
    connect(options) {
      calls.push({ method: 'connect', args: [] });
      emit = options.onEvent;
      emitError = options.onError ?? null;
      return { close() {}, lastEventId: 0, ready: Promise.resolve() };
    },
    async loadSession(input) {
      calls.push({ method: 'loadSession', args: [input] });
      return {
        sessionId: input.sessionId,
        configOptions: [
          { id: 'model', currentValue: 'kortix/glm-5.2' },
          { id: 'mode', currentValue: 'build' },
        ],
      };
    },
    async setSessionConfigOption(sessionId, configId, value) {
      calls.push({
        method: 'setSessionConfigOption',
        args: [sessionId, configId, value],
      });
      return {};
    },
    async prompt(sessionId, prompt) {
      calls.push({ method: 'prompt', args: [sessionId, prompt] });
      emit?.({
        id: 1,
        envelope: {
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'PONG' },
            },
          },
        },
      });
      return {
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
    async cancel(sessionId) {
      calls.push({ method: 'cancel', args: [sessionId] });
    },
    async respond(id, result) {
      calls.push({ method: 'respond', args: [id, result] });
    },
  };
  return {
    client,
    calls,
    emit(envelope: AcpEnvelope, id = 1) {
      emit?.({ id, envelope });
    },
    emitError(error: unknown) {
      emitError?.(error);
    },
  };
}

describe('ACP session controller', () => {
  test('opens the stream before loading the canonical OpenCode session', async () => {
    const h = harness();
    const controller = createAcpSessionController({
      sessionId: 'ses_1',
      client: h.client,
    });
    await controller.connect();

    expect(h.calls.slice(0, 2)).toEqual([
      { method: 'connect', args: [] },
      {
        method: 'loadSession',
        args: [{ sessionId: 'ses_1', cwd: '/workspace' }],
      },
    ]);
    expect(controller.getSnapshot().ready).toBe(true);
    expect(controller.getSnapshot().configOptions).toHaveLength(2);
  });

  test('projects transcript updates replayed during session/load', async () => {
    const h = harness();
    h.client.loadSession = async (input) => {
      h.emit({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: input.sessionId,
          update: {
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text: 'previous question' },
          },
        },
      });
      h.emit({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: input.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'previous answer' },
          },
        },
      });
      return {};
    };
    const controller = createAcpSessionController({
      sessionId: 'ses_1',
      client: h.client,
    });

    await controller.connect();

    expect(controller.getSnapshot().projection.messages).toMatchObject([
      {
        info: { role: 'user' },
        parts: [{ type: 'text', text: 'previous question' }],
      },
      {
        info: { role: 'assistant' },
        parts: [{ type: 'text', text: 'previous answer' }],
      },
    ]);
    expect(controller.getSnapshot().projection.status).toEqual({
      type: 'idle',
    });
    const restoredAssistant = controller.getSnapshot().projection.messages.at(-1)?.info;
    expect(restoredAssistant?.role).toBe('assistant');
    if (restoredAssistant?.role === 'assistant') {
      expect(restoredAssistant.time.completed).toEqual(expect.any(Number));
    }
  });

  test('preserves a pending client request replayed while the stream opens', async () => {
    const h = harness();
    const connect = h.client.connect;
    h.client.connect = (options) => {
      const stream = connect(options);
      options.onEvent({
        id: 12,
        envelope: {
          jsonrpc: '2.0',
          id: 'kortix:question:q1',
          method: 'session/request_input',
          params: {
            sessionId: 'ses_1',
            questions: [{ question: 'Choose one', options: ['Alpha', 'Beta'] }],
          },
        },
      });
      return stream;
    };
    const controller = createAcpSessionController({
      sessionId: 'ses_1',
      client: h.client,
    });

    await controller.connect();

    expect(controller.getSnapshot().projection.questions).toEqual([
      expect.objectContaining({
        id: 'kortix:question:q1',
        questions: [
          expect.objectContaining({
            question: 'Choose one',
          }),
        ],
      }),
    ]);
  });

  test('applies model and agent options before one ACP prompt', async () => {
    const h = harness();
    const controller = createAcpSessionController({
      sessionId: 'ses_1',
      client: h.client,
    });
    await controller.connect();
    await controller.send([{ type: 'text', text: 'ping' }], {
      model: 'kortix/glm-5.2',
      agent: 'reviewer',
    });

    expect(h.calls.slice(2)).toEqual([
      {
        method: 'setSessionConfigOption',
        args: ['ses_1', 'model', 'kortix/glm-5.2'],
      },
      {
        method: 'setSessionConfigOption',
        args: ['ses_1', 'mode', 'reviewer'],
      },
      {
        method: 'prompt',
        args: ['ses_1', [{ type: 'text', text: 'ping' }]],
      },
    ]);
    expect(controller.getSnapshot().projection.messages.at(-1)?.parts).toMatchObject([
      { type: 'text', text: 'PONG' },
      { type: 'step-finish', reason: 'end_turn' },
    ]);
  });

  test('does not expose idle before late prompt updates reach the transcript', async () => {
    const h = harness();
    let lateToolCompleted = false;
    h.client.prompt = async (sessionId, prompt) => {
      h.calls.push({ method: 'prompt', args: [sessionId, prompt] });
      setTimeout(() => {
        h.emit({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'late-tool',
              title: 'web_search',
              kind: 'fetch',
              status: 'in_progress',
              rawInput: { query: 'Marko Kraemer' },
            },
          },
        });
      }, 0);
      setTimeout(() => {
        h.emit({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Presentation complete' },
            },
          },
        });
        h.emit({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'late-tool',
              status: 'completed',
              rawOutput: { output: 'Research complete' },
            },
          },
        });
        lateToolCompleted = true;
      }, 20);
      const result = {
        stopReason: 'end_turn',
        usage: { inputTokens: 4, outputTokens: 2 },
      };
      h.emit({
        jsonrpc: '2.0',
        id: 'prompt-response',
        result,
      });
      return result;
    };
    const controller = createAcpSessionController({
      sessionId: 'ses_1',
      client: h.client,
    });
    await controller.connect();
    const busySamples: boolean[] = [];
    let observedBusy = false;
    let resolveStableIdle: () => void = () => {};
    const stableIdle = new Promise<void>((resolve) => {
      resolveStableIdle = resolve;
    });
    controller.subscribe(() => {
      const snapshot = controller.getSnapshot();
      const busy = snapshot.sending || snapshot.projection.status.type !== 'idle';
      busySamples.push(busy);
      if (busy) observedBusy = true;
      else if (observedBusy) resolveStableIdle();
    });

    await controller.send([{ type: 'text', text: 'create a presentation' }]);
    await stableIdle;

    expect(lateToolCompleted).toBe(true);
    const firstBusy = busySamples.indexOf(true);
    expect(firstBusy).toBeGreaterThanOrEqual(0);
    expect(busySamples.slice(firstBusy, -1).every(Boolean)).toBe(true);
    expect(busySamples.at(-1)).toBe(false);
    expect(controller.getSnapshot().projection.messages.at(-1)?.parts).toMatchObject([
      {
        type: 'tool',
        callID: 'late-tool',
        state: {
          status: 'completed',
          output: 'Research complete',
        },
      },
      { type: 'text', text: 'Presentation complete' },
      { type: 'step-finish', reason: 'end_turn' },
    ]);
  });

  test('serializes prompts that the busy-message queue drains at a tool boundary', async () => {
    const h = harness();
    let releaseFirst: () => void = () => {};
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let promptCount = 0;
    h.client.prompt = async (sessionId, prompt) => {
      h.calls.push({ method: 'prompt', args: [sessionId, prompt] });
      promptCount += 1;
      if (promptCount === 1) await firstBlocked;
      return { stopReason: 'end_turn' };
    };
    const controller = createAcpSessionController({
      sessionId: 'ses_1',
      client: h.client,
    });
    await controller.connect();

    const first = controller.send([{ type: 'text', text: 'first' }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = controller.send([{ type: 'text', text: 'queued' }]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.calls.filter((call) => call.method === 'prompt').map((call) => call.args[1])).toEqual([
      [{ type: 'text', text: 'first' }],
    ]);

    releaseFirst();
    await Promise.all([first, second]);

    expect(h.calls.filter((call) => call.method === 'prompt').map((call) => call.args[1])).toEqual([
      [{ type: 'text', text: 'first' }],
      [{ type: 'text', text: 'queued' }],
    ]);
  });

  test('answers ACP permission requests with the matching option id', async () => {
    const h = harness();
    const controller = createAcpSessionController({
      sessionId: 'ses_1',
      client: h.client,
    });
    await controller.connect();
    h.emit({
      jsonrpc: '2.0',
      id: 'permission-1',
      method: 'session/request_permission',
      params: {
        sessionId: 'ses_1',
        options: [
          { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
          { optionId: 'allow_always', kind: 'allow_always', name: 'Always' },
          { optionId: 'reject_once', kind: 'reject_once', name: 'Reject' },
        ],
      },
    });

    await controller.answerPermission('permission-1', 'always');
    expect(h.calls.at(-1)).toEqual({
      method: 'respond',
      args: ['permission-1', { outcome: { outcome: 'selected', optionId: 'allow_always' } }],
    });
    expect(controller.getSnapshot().projection.permissions).toEqual([]);
  });

  test('preserves a numeric ACP permission request id in the response', async () => {
    const h = harness();
    const controller = createAcpSessionController({
      sessionId: 'ses_1',
      client: h.client,
    });
    await controller.connect();
    h.emit({
      jsonrpc: '2.0',
      id: 0,
      method: 'session/request_permission',
      params: {
        sessionId: 'ses_1',
        options: [{ optionId: 'always', kind: 'allow_always', name: 'Always' }],
      },
    });

    await controller.answerPermission('0', 'always');

    expect(h.calls.at(-1)).toEqual({
      method: 'respond',
      args: [0, { outcome: { outcome: 'selected', optionId: 'always' } }],
    });
  });

  test('preserves a numeric ACP question request id in the response', async () => {
    const h = harness();
    const controller = createAcpSessionController({
      sessionId: 'ses_1',
      client: h.client,
    });
    await controller.connect();
    h.emit({
      jsonrpc: '2.0',
      id: 7,
      method: 'session/request_input',
      params: {
        sessionId: 'ses_1',
        questions: [{ question: 'Choose one', options: ['Alpha', 'Beta'] }],
      },
    });

    await controller.answerQuestion('7', [['Beta']]);

    expect(h.calls.at(-1)).toEqual({
      method: 'respond',
      args: [7, { action: 'accept', content: { answers: [['Beta']] } }],
    });
  });

  test('cancels a rejected permission request when no reject option exists', async () => {
    const h = harness();
    const controller = createAcpSessionController({
      sessionId: 'ses_1',
      client: h.client,
    });
    await controller.connect();
    h.emit({
      jsonrpc: '2.0',
      id: 'permission-1',
      method: 'session/request_permission',
      params: {
        sessionId: 'ses_1',
        options: [{ optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' }],
      },
    });

    await controller.answerPermission('permission-1', 'reject');

    expect(h.calls.at(-1)).toEqual({
      method: 'respond',
      args: ['permission-1', { outcome: { outcome: 'cancelled' } }],
    });
    expect(controller.getSnapshot().projection.permissions).toEqual([]);
  });

  test('rejects an allow reply when no compatible allow option exists', async () => {
    const h = harness();
    const controller = createAcpSessionController({
      sessionId: 'ses_1',
      client: h.client,
    });
    await controller.connect();
    h.emit({
      jsonrpc: '2.0',
      id: 'permission-1',
      method: 'session/request_permission',
      params: {
        sessionId: 'ses_1',
        options: [{ optionId: 'reject_once', kind: 'reject_once', name: 'Reject' }],
      },
    });

    await expect(controller.answerPermission('permission-1', 'once')).rejects.toThrow(
      'ACP permission request permission-1 has no compatible once option',
    );
    expect(h.calls.filter((call) => call.method === 'respond')).toEqual([]);
  });

  test('ignores reconnectable stream errors and records terminal failures', async () => {
    const h = harness();
    const controller = createAcpSessionController({
      sessionId: 'ses_1',
      client: h.client,
    });
    await controller.connect();

    h.emitError(new AcpTransportError('temporary outage', 503, false));
    expect(controller.getSnapshot()).toMatchObject({
      connection: 'open',
      error: null,
    });

    h.emitError(new AcpTransportError('permission denied', 403, true));
    expect(controller.getSnapshot()).toMatchObject({
      connection: 'error',
      error: { message: 'permission denied' },
    });
  });

  test('reloads the canonical session after OpenCode reports a new ACP process', async () => {
    const h = harness();
    const controller = createAcpSessionController({
      sessionId: 'ses_1',
      client: h.client,
    });
    await controller.connect();

    h.emit({
      jsonrpc: '2.0',
      method: 'kortix/runtime_ready',
      params: { sessionId: 'ses_1' },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.calls.filter((call) => call.method === 'loadSession')).toHaveLength(2);
    expect(controller.getSnapshot()).toMatchObject({
      ready: true,
      connection: 'open',
      error: null,
    });
  });

  test('replaces the projection with runtime replay instead of duplicating it', async () => {
    const h = harness();
    h.client.loadSession = async (input) => {
      h.calls.push({ method: 'loadSession', args: [input] });
      h.emit({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: input.sessionId,
          update: {
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text: 'question' },
          },
        },
      });
      h.emit({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: input.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'answer' },
          },
        },
      });
      return {};
    };
    const controller = createAcpSessionController({
      sessionId: 'ses_1',
      client: h.client,
    });
    await controller.connect();
    expect(controller.getSnapshot().projection.messages).toHaveLength(2);

    h.emit({
      jsonrpc: '2.0',
      method: 'kortix/runtime_ready',
      params: { sessionId: 'ses_1' },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(controller.getSnapshot().projection.messages).toHaveLength(2);
    expect(
      controller.getSnapshot().projection.messages.map((message) => message.info.role),
    ).toEqual(['user', 'assistant']);
  });

  test('restarts config preflight after runtime_ready interrupts a send', async () => {
    const h = harness();
    let configCallCount = 0;
    h.client.setSessionConfigOption = async (sessionId, configId, value) => {
      h.calls.push({
        method: 'setSessionConfigOption',
        args: [sessionId, configId, value],
      });
      configCallCount += 1;
      if (configCallCount === 1) {
        await new Promise<never>(() => {});
      }
      return {};
    };
    const controller = createAcpSessionController({
      sessionId: 'ses_1',
      client: h.client,
    });
    await controller.connect();

    const send = controller.send([{ type: 'text', text: 'after restart' }], {
      model: 'kortix/glm-5.2',
      agent: 'reviewer',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.calls.filter((call) => call.method === 'setSessionConfigOption')).toHaveLength(1);

    h.emit({
      jsonrpc: '2.0',
      method: 'kortix/runtime_ready',
      params: { sessionId: 'ses_1' },
    });

    const completed = await Promise.race([
      send.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 50)),
    ]);
    expect(completed).toBe(true);
    expect(h.calls.filter((call) => call.method === 'loadSession')).toHaveLength(2);
    expect(h.calls.filter((call) => call.method === 'setSessionConfigOption')).toEqual([
      {
        method: 'setSessionConfigOption',
        args: ['ses_1', 'model', 'kortix/glm-5.2'],
      },
      {
        method: 'setSessionConfigOption',
        args: ['ses_1', 'model', 'kortix/glm-5.2'],
      },
      {
        method: 'setSessionConfigOption',
        args: ['ses_1', 'mode', 'reviewer'],
      },
    ]);
    expect(h.calls.filter((call) => call.method === 'prompt')).toEqual([
      {
        method: 'prompt',
        args: ['ses_1', [{ type: 'text', text: 'after restart' }]],
      },
    ]);
  });

  test('does not retry a prompt after runtime_ready makes its result ambiguous', async () => {
    const h = harness();
    h.client.prompt = async (sessionId, prompt) => {
      h.calls.push({ method: 'prompt', args: [sessionId, prompt] });
      return await new Promise<{ stopReason: string }>(() => {});
    };
    const controller = createAcpSessionController({
      sessionId: 'ses_1',
      client: h.client,
    });
    await controller.connect();

    const send = controller.send([{ type: 'text', text: 'one prompt only' }]);
    const outcome = send.then(
      () => 'resolved',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.calls.filter((call) => call.method === 'prompt')).toHaveLength(1);

    h.emit({
      jsonrpc: '2.0',
      method: 'kortix/runtime_ready',
      params: { sessionId: 'ses_1' },
    });

    expect(
      await Promise.race([
        outcome,
        new Promise<'timed out'>((resolve) => setTimeout(() => resolve('timed out'), 50)),
      ]),
    ).toBe('ACP runtime restarted after session/prompt dispatch; the prompt result is unknown');
    expect(h.calls.filter((call) => call.method === 'prompt')).toHaveLength(1);
  });

  test('returns explicit unsupported errors for undo and redo', async () => {
    const h = harness();
    const controller = createAcpSessionController({
      sessionId: 'ses_1',
      client: h.client,
    });
    await controller.connect();

    await expect(controller.runCommand('undo', '')).rejects.toThrow(
      'OpenCode ACP does not support /undo',
    );
    await expect(controller.runCommand('redo', '')).rejects.toThrow(
      'OpenCode ACP does not support /redo',
    );
  });

  test('records a prompt transport error in the controller snapshot', async () => {
    const h = harness();
    h.client.prompt = async () => {
      throw new Error('ACP prompt failed');
    };
    const controller = createAcpSessionController({
      sessionId: 'ses_1',
      client: h.client,
    });
    await controller.connect();

    await expect(controller.send([{ type: 'text', text: 'ping' }])).rejects.toThrow(
      'ACP prompt failed',
    );
    expect(controller.getSnapshot()).toMatchObject({
      sending: false,
      error: { message: 'ACP prompt failed' },
    });
  });
});

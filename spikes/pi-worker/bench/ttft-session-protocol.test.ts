import { describe, expect, test } from 'bun:test';
import {
  JsonSseDecoder,
  TurnEventProbe,
  mintBenchmarkMessageId,
  parseBenchmarkDeclaration,
  selectRuntimeSessionId,
  unwrapProductEvent,
} from './ttft-session-protocol.ts';

const DECLARATION = [
  '--runtime',
  'pi',
  '--provider',
  'Daytona',
  '--region',
  'eu-central',
  '--model',
  'anthropic/claude-sonnet-4.5',
  '--worker-path',
  'cold-create',
  '--workspace-path',
  'not-observed',
] as const;

describe('benchmark metadata', () => {
  test('requires the dimensions needed for an honest comparison', () => {
    expect(parseBenchmarkDeclaration(DECLARATION)).toEqual({
      label: 'pi-cold-create',
      runtime: 'pi',
      provider: 'daytona',
      region: 'eu-central',
      model: 'anthropic/claude-sonnet-4.5',
      workerPath: 'cold-create',
      workspacePath: 'not-observed',
      tool: false,
    });
    expect(() =>
      parseBenchmarkDeclaration(DECLARATION.filter((value) => value !== 'eu-central')),
    ).toThrow('missing --region');
    expect(() => parseBenchmarkDeclaration([...DECLARATION, '--tool'])).toThrow(
      '--tool requires an observed --workspace-path',
    );
  });

  test('mints a native sortable OpenCode message id', () => {
    expect(mintBenchmarkMessageId(1_700_000_000_000, () => 0)).toMatch(
      /^msg_[0-9a-f]{12}[A-Za-z0-9]{14}$/,
    );
  });
});

describe('product SSE decoding', () => {
  test('decodes split CRLF records and the /global/event envelope', () => {
    const decoder = new JsonSseDecoder();
    expect(
      decoder.push(
        new TextEncoder().encode(
          'id: 1\r\ndata: {"directory":"/workspace","payload":{"id":"evt_1","type":"session.status","properties":{"sessionID":"ses_1"}}}\r',
        ),
      ),
    ).toEqual([]);
    const events = decoder.push(new TextEncoder().encode('\n\r\n'));
    expect(events).toHaveLength(1);
    expect(unwrapProductEvent(events[0])).toEqual({
      id: 'evt_1',
      type: 'session.status',
      properties: { sessionID: 'ses_1' },
    });
  });

  test('rejects malformed data instead of silently losing the first token', () => {
    const decoder = new JsonSseDecoder();
    expect(() => decoder.push(new TextEncoder().encode('data: {broken}\n\n'))).toThrow(
      'global event stream returned invalid JSON',
    );
  });
});

describe('assistant event observation', () => {
  test('ignores echoed user text and unrelated sessions', () => {
    const probe = new TurnEventProbe('ses_1', 'msg_user', false, 'KORTIX-TOOL-PROBE');
    probe.accept(
      {
        type: 'message.part.updated',
        properties: {
          sessionID: 'ses_1',
          part: { sessionID: 'ses_1', messageID: 'msg_user', type: 'text', text: 'prompt' },
        },
      },
      10,
    );
    probe.accept(
      {
        directory: '/workspace',
        payload: {
          type: 'message.updated',
          properties: {
            info: {
              id: 'msg_other',
              sessionID: 'ses_other',
              role: 'assistant',
              parentID: 'msg_user',
            },
          },
        },
      },
      20,
    );
    expect(probe.snapshot().firstTokenMs).toBeUndefined();

    probe.accept(
      {
        directory: '/workspace',
        payload: {
          type: 'message.updated',
          properties: {
            info: {
              id: 'msg_assistant',
              sessionID: 'ses_1',
              role: 'assistant',
              parentID: 'msg_user',
              providerID: 'kortix',
              modelID: 'anthropic/claude-sonnet-4.5',
            },
          },
        },
      },
      30,
    );
    probe.accept(
      {
        directory: '/workspace',
        payload: {
          type: 'message.part.delta',
          properties: {
            sessionID: 'ses_1',
            messageID: 'msg_assistant',
            partID: 'prt_1',
            field: 'text',
            delta: 'R',
          },
        },
      },
      42,
    );

    expect(probe.complete).toBe(true);
    expect(probe.snapshot()).toMatchObject({
      firstTokenMs: 42,
      assistantMessageIds: ['msg_assistant'],
      observedModels: ['kortix/anthropic/claude-sonnet-4.5'],
    });
  });

  test('requires the sentinel-bearing completed tool result in tool mode', () => {
    const probe = new TurnEventProbe('ses_1', 'msg_user', true, 'KORTIX-TOOL-PROBE');
    probe.accept(
      {
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg_assistant',
            sessionID: 'ses_1',
            role: 'assistant',
            parentID: 'msg_user',
          },
        },
      },
      5,
    );
    probe.accept(
      {
        type: 'message.part.delta',
        properties: {
          sessionID: 'ses_1',
          messageID: 'msg_assistant',
          field: 'text',
          delta: 'working',
        },
      },
      12,
    );
    probe.accept(
      {
        type: 'message.part.updated',
        properties: {
          sessionID: 'ses_1',
          part: {
            messageID: 'msg_assistant',
            sessionID: 'ses_1',
            type: 'tool',
            state: { status: 'completed', output: 'wrong command' },
          },
        },
      },
      20,
    );
    expect(probe.complete).toBe(false);
    probe.accept(
      {
        type: 'message.part.updated',
        properties: {
          sessionID: 'ses_1',
          part: {
            messageID: 'msg_assistant',
            sessionID: 'ses_1',
            type: 'tool',
            state: { status: 'completed', output: 'KORTIX-TOOL-PROBE\n' },
          },
        },
      },
      31,
    );
    expect(probe.complete).toBe(true);
    expect(probe.snapshot()).toMatchObject({ firstTokenMs: 12, firstToolResultMs: 31 });
  });
});

describe('runtime session selection', () => {
  test('uses the control-plane pin and fails on ambiguity', () => {
    expect(selectRuntimeSessionId([{ id: 'ses_a' }, { id: 'ses_b' }], 'ses_b')).toBe('ses_b');
    expect(() => selectRuntimeSessionId([{ id: 'ses_a' }, { id: 'ses_b' }], null)).toThrow(
      'runtime session is ambiguous',
    );
    expect(() => selectRuntimeSessionId([{ id: 'ses_a' }], 'ses_missing')).toThrow(
      'does not contain pinned id',
    );
  });
});

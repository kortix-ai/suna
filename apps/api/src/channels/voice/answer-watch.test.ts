import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { projectSessions } from '@kortix/db';

import type { AcpEnvelopeDirection, StoredAcpEnvelope } from '../../projects/lib/acp-transcript';
import type { KortixUtterance } from './utterance';

let sessionRows: Array<Record<string, unknown>> = [];
let sandboxRows: Array<Record<string, unknown>> = [];

mock.module('../../shared/db', () => ({
  hasDatabase: true,
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => (table === projectSessions ? sessionRows : sandboxRows),
        }),
      }),
    }),
  },
}));

let envelopeReads: Array<{ projectId: string; sessionId: string }> = [];
let envelopeStates: StoredAcpEnvelope[][] = [];
let envelopeThrow: Error | null = null;

mock.module('../../projects/lib/acp-transcript', () => ({
  loadAcpTranscript: async (input: { projectId: string; sessionId: string }) => {
    envelopeReads.push(input);
    if (envelopeThrow) throw envelopeThrow;
    return envelopeStates.length > 1
      ? (envelopeStates.shift() as StoredAcpEnvelope[])
      : (envelopeStates[0] ?? []);
  },
}));

let endpointCalls = 0;

mock.module('../../projects/opencode-mapping', () => ({
  sandboxOpencodeEndpoint: async () => {
    endpointCalls += 1;
    return { url: 'http://daemon.local', headers: { 'x-kortix-signature': 'sig' } };
  },
}));

let spoken: Array<{ callId: string; utterance: KortixUtterance }> = [];
let settled: Array<{ callId: string; outcome: string }> = [];

mock.module('./runtime', () => ({
  promptVoiceAgent: async (callId: string, utterance: KortixUtterance) => {
    spoken.push({ callId, utterance });
    return { delivered: true };
  },
  settleAsk: async (callId: string, outcome: string) => {
    settled.push({ callId, outcome });
  },
}));

const { MAX_WAIT_MS, speakAnswerWhenReady, watchForAnswer } = await import('./answer-watch');

const FAST = { maxWaitMs: 400, pollIntervalMs: 5 };
const CALL_ID = 'call-1';
const SESSION_ID = 'call-1';
const BASE_MS = 1_700_000_000_000;

beforeEach(() => {
  sessionRows = [];
  sandboxRows = [];
  envelopeReads = [];
  envelopeStates = [];
  envelopeThrow = null;
  endpointCalls = 0;
  spoken = [];
  settled = [];
  globalThis.fetch = mock(
    async () => new Response('[]', { status: 200 }),
  ) as unknown as typeof fetch;
});

function acpSessionRow(overrides: Record<string, unknown> = {}) {
  return {
    projectId: 'project-1',
    createdBy: 'user-1',
    opencodeSessionId: 'acp-server-1',
    metadata: {
      runtime_transport: 'acp',
      runtime_harness: 'claude',
      acp_server_id: 'acp-server-1',
      acp_session_id: 'ses_1',
    },
    ...overrides,
  };
}

function restSessionRow(overrides: Record<string, unknown> = {}) {
  return {
    projectId: 'project-1',
    createdBy: 'user-1',
    opencodeSessionId: 'oc-session-1',
    metadata: {},
    ...overrides,
  };
}

function log(
  ...entries: Array<[AcpEnvelopeDirection, Record<string, unknown>]>
): StoredAcpEnvelope[] {
  return entries.map(([direction, envelope], index) => ({
    ordinal: index + 1,
    direction,
    streamEventId: null,
    envelope,
    createdAt: new Date(BASE_MS + index * 1_000).toISOString(),
  }));
}

function chunk(messageId: string, text: string): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId: 'ses_1',
      update: { sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text } },
    },
  };
}

function promptRequest(id: number, text: string): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    method: 'session/prompt',
    params: { sessionId: 'ses_1', prompt: [{ type: 'text', text }] },
  };
}

function promptResult(id: number): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } };
}

const PRIOR_TURN: Array<[AcpEnvelopeDirection, Record<string, unknown>]> = [
  ['client_to_agent', promptRequest(1, 'earlier question')],
  ['agent_to_client', chunk('msg_0', 'A stale answer nobody asked for now.')],
  ['agent_to_client', promptResult(1)],
];

const NEW_TURN: Array<[AcpEnvelopeDirection, Record<string, unknown>]> = [
  ['client_to_agent', promptRequest(2, 'what is the build status?')],
  ['agent_to_client', chunk('msg_1', 'The build is green.')],
  ['agent_to_client', promptResult(2)],
];

async function waitForSettle(): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (settled.length > 0) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('the watch never settled the ask');
}

function restMessage(id: string, text: string, completed: number | null) {
  return {
    info: {
      id,
      role: 'assistant',
      time: { created: completed ?? BASE_MS, ...(completed ? { completed } : {}) },
    },
    parts: [{ type: 'text', text }],
  };
}

describe('an ACP session', () => {
  test('the completed answer is found in the envelope log and spoken', async () => {
    sessionRows = [acpSessionRow()];
    envelopeStates = [log(...PRIOR_TURN), log(...PRIOR_TURN, ...NEW_TURN)];

    const outcome = await watchForAnswer(CALL_ID, SESSION_ID, FAST);

    expect(outcome).toBe('answered');
    expect(spoken).toHaveLength(1);
    expect(spoken[0].utterance.kind).toBe('result');
    expect(spoken[0].utterance.transcript).toBe('The build is green.');
  });

  test('no sandbox HTTP call is made to read it', async () => {
    sessionRows = [acpSessionRow()];
    envelopeStates = [log(...PRIOR_TURN), log(...PRIOR_TURN, ...NEW_TURN)];

    await watchForAnswer(CALL_ID, SESSION_ID, FAST);

    expect(fetch).not.toHaveBeenCalled();
    expect(endpointCalls).toBe(0);
    expect(envelopeReads).toEqual(
      envelopeReads.map(() => ({ projectId: 'project-1', sessionId: SESSION_ID })),
    );
    expect(envelopeReads.length).toBeGreaterThan(0);
  });

  test('a turn already finished before the ask is not read out as the answer', async () => {
    sessionRows = [acpSessionRow()];
    envelopeStates = [log(...PRIOR_TURN)];

    const outcome = await watchForAnswer(CALL_ID, SESSION_ID, FAST);

    expect(outcome).toBe('timed out');
    expect(spoken).toHaveLength(0);
  });

  test('a failed prompt is spoken as a failure, not as an answer', async () => {
    sessionRows = [acpSessionRow()];
    envelopeStates = [
      log(...PRIOR_TURN),
      log(
        ...PRIOR_TURN,
        ['client_to_agent', promptRequest(2, 'what is the build status?')],
        [
          'agent_to_client',
          { jsonrpc: '2.0', id: 2, error: { code: -32603, message: 'model overloaded' } },
        ],
      ),
    ];

    const outcome = await watchForAnswer(CALL_ID, SESSION_ID, FAST);

    expect(outcome).toBe('failed');
    expect(spoken[0].utterance.kind).toBe('error');
    expect(spoken[0].utterance.transcript).toContain('model overloaded');
  });

  test('a turn that only ran tools reports nothing to say', async () => {
    sessionRows = [acpSessionRow()];
    envelopeStates = [
      log(...PRIOR_TURN),
      log(
        ...PRIOR_TURN,
        ['client_to_agent', promptRequest(2, 'run the tests')],
        ['agent_to_client', promptResult(2)],
      ),
    ];

    const outcome = await watchForAnswer(CALL_ID, SESSION_ID, FAST);

    expect(outcome).toBe('nothing to say');
    expect(spoken).toHaveLength(0);
  });

  test('a session/load replay does not duplicate the spoken answer', async () => {
    sessionRows = [acpSessionRow()];
    const replay: Array<[AcpEnvelopeDirection, Record<string, unknown>]> = [
      [
        'client_to_agent',
        { jsonrpc: '2.0', id: 9, method: 'session/load', params: { sessionId: 'ses_1' } },
      ],
      ['agent_to_client', chunk('msg_0', 'A stale answer nobody asked for now.')],
      ['agent_to_client', chunk('msg_1', 'The build is green.')],
      ['agent_to_client', { jsonrpc: '2.0', id: 9, result: {} }],
    ];
    envelopeStates = [log(...PRIOR_TURN), log(...PRIOR_TURN, ...NEW_TURN, ...replay, ...replay)];

    const outcome = await watchForAnswer(CALL_ID, SESSION_ID, FAST);

    expect(outcome).toBe('answered');
    expect(spoken[0].utterance.transcript).toBe('The build is green.');
  });

  test('an unreadable envelope log is reported rather than polled in silence', async () => {
    sessionRows = [acpSessionRow()];
    envelopeThrow = new Error('connection terminated');

    const outcome = await watchForAnswer(CALL_ID, SESSION_ID, FAST);

    expect(outcome).toBe('timed out');
    expect(spoken).toHaveLength(0);
  });
});

describe('an OpenCode REST session', () => {
  test('its behaviour is unchanged and the envelope log is never read', async () => {
    sessionRows = [restSessionRow()];
    sandboxRows = [{ externalId: 'sbx-1' }];
    const responses = [
      [restMessage('m1', 'stale answer', BASE_MS)],
      [
        restMessage('m1', 'stale answer', BASE_MS),
        restMessage('m2', 'The build is green.', BASE_MS + 1),
      ],
    ];
    let call = 0;
    globalThis.fetch = mock(async () => {
      const body = responses[Math.min(call, responses.length - 1)];
      call += 1;
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;

    const outcome = await watchForAnswer(CALL_ID, SESSION_ID, FAST);

    expect(outcome).toBe('answered');
    expect(spoken[0].utterance.transcript).toBe('The build is green.');
    expect(envelopeReads).toHaveLength(0);
    expect(endpointCalls).toBeGreaterThan(0);
    const url = String((fetch as unknown as ReturnType<typeof mock>).mock.calls[0][0]);
    expect(url).toContain('/session/oc-session-1/message');
  });

  test('a session with no OpenCode pin and no ACP identity is unreadable', async () => {
    sessionRows = [restSessionRow({ opencodeSessionId: null })];

    const outcome = await watchForAnswer(CALL_ID, SESSION_ID, FAST);

    expect(outcome).toBe('session unreadable');
    expect(spoken).toHaveLength(0);
  });
});

describe('the ask ledger hand-off', () => {
  test('a completed ACP answer settles the ask exactly once', async () => {
    sessionRows = [acpSessionRow()];
    envelopeStates = [log(...PRIOR_TURN), log(...PRIOR_TURN, ...NEW_TURN)];

    speakAnswerWhenReady(CALL_ID, SESSION_ID, FAST);
    await waitForSettle();
    await new Promise((r) => setTimeout(r, 60));

    expect(settled).toEqual([{ callId: CALL_ID, outcome: 'answered' }]);
  });

  test('a turn that never completes settles by the deadline', async () => {
    sessionRows = [acpSessionRow()];
    envelopeStates = [log(...PRIOR_TURN)];

    speakAnswerWhenReady(CALL_ID, SESSION_ID, FAST);
    await waitForSettle();

    expect(settled).toEqual([{ callId: CALL_ID, outcome: 'timed out' }]);
  });

  test('the production budget the ledger is ordered against is unchanged', () => {
    expect(MAX_WAIT_MS).toBe(6 * 60_000);
  });
});

import { describe, expect, test } from 'bun:test';

import type { AcpEnvelopeDirection, StoredAcpEnvelope } from '../../projects/lib/acp-transcript';
import { acpSpokenAnswer, latestAcpTurnCompletion } from './acp-answer';

const BASE_MS = 1_700_000_000_000;

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
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId,
        content: { type: 'text', text },
      },
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

function promptResult(id: number, stopReason = 'end_turn'): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result: { stopReason } };
}

const HANDSHAKE: Array<[AcpEnvelopeDirection, Record<string, unknown>]> = [
  ['client_to_agent', { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }],
  ['agent_to_client', { jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } }],
  [
    'client_to_agent',
    { jsonrpc: '2.0', id: 2, method: 'session/load', params: { sessionId: 'ses_1' } },
  ],
  ['agent_to_client', { jsonrpc: '2.0', id: 2, result: {} }],
];

describe('latestAcpTurnCompletion', () => {
  test('a log with no prompt response has no completed turn', () => {
    const envelopes = log(
      ...HANDSHAKE,
      ['client_to_agent', promptRequest(3, 'what does this repo do?')],
      ['agent_to_client', chunk('msg_1', 'Still working')],
    );
    expect(latestAcpTurnCompletion(envelopes)).toBeNull();
  });

  test('the handshake responses are not mistaken for a finished turn', () => {
    expect(latestAcpTurnCompletion(log(...HANDSHAKE))).toBeNull();
  });

  test('the prompt response is the completion signal and carries its stopReason', () => {
    const envelopes = log(
      ...HANDSHAKE,
      ['client_to_agent', promptRequest(3, 'what does this repo do?')],
      ['agent_to_client', chunk('msg_1', 'It is the Kortix monorepo.')],
      ['agent_to_client', promptResult(3)],
    );
    expect(latestAcpTurnCompletion(envelopes)).toEqual({
      ordinal: 7,
      promptOrdinal: 5,
      stopReason: 'end_turn',
      error: null,
    });
  });

  test('a JSON-RPC error response reports the failure', () => {
    const envelopes = log(
      ...HANDSHAKE,
      ['client_to_agent', promptRequest(3, 'what does this repo do?')],
      [
        'agent_to_client',
        { jsonrpc: '2.0', id: 3, error: { code: -32603, message: 'model overloaded' } },
      ],
    );
    expect(latestAcpTurnCompletion(envelopes)).toEqual({
      ordinal: 6,
      promptOrdinal: 5,
      stopReason: null,
      error: 'model overloaded',
    });
  });

  test('the newest of two finished turns wins', () => {
    const envelopes = log(
      ...HANDSHAKE,
      ['client_to_agent', promptRequest(3, 'first')],
      ['agent_to_client', chunk('msg_1', 'first answer')],
      ['agent_to_client', promptResult(3)],
      ['client_to_agent', promptRequest(4, 'second')],
      ['agent_to_client', chunk('msg_2', 'second answer')],
      ['agent_to_client', promptResult(4, 'max_tokens')],
    );
    expect(latestAcpTurnCompletion(envelopes)).toEqual({
      ordinal: 10,
      promptOrdinal: 8,
      stopReason: 'max_tokens',
      error: null,
    });
  });

  test('a permission reply the client sent is not a turn completion', () => {
    const envelopes = log(
      ...HANDSHAKE,
      ['client_to_agent', promptRequest(3, 'what does this repo do?')],
      [
        'agent_to_client',
        { jsonrpc: '2.0', id: 3, method: 'session/request_permission', params: { options: [] } },
      ],
      ['client_to_agent', { jsonrpc: '2.0', id: 3, result: { outcome: { outcome: 'cancelled' } } }],
    );
    expect(latestAcpTurnCompletion(envelopes)).toBeNull();
  });
});

describe('acpSpokenAnswer', () => {
  function spoken(envelopes: StoredAcpEnvelope[], maxChars = 1_200): string {
    const turn = latestAcpTurnCompletion(envelopes);
    if (!turn) throw new Error('the log has no completed turn to speak');
    return acpSpokenAnswer(envelopes, turn, { acpSessionId: 'ses_1', maxChars });
  }

  test('the newest assistant message is what gets read aloud', () => {
    const envelopes = log(
      ...HANDSHAKE,
      ['client_to_agent', promptRequest(3, 'first')],
      ['agent_to_client', chunk('msg_1', 'first answer')],
      ['agent_to_client', promptResult(3)],
      ['client_to_agent', promptRequest(4, 'second')],
      ['agent_to_client', chunk('msg_2', 'The build is green.')],
      ['agent_to_client', promptResult(4)],
    );
    expect(spoken(envelopes)).toBe('The build is green.');
  });

  test('a session row with no stored acp_session_id still reads its own answer', () => {
    const envelopes = log(
      ...HANDSHAKE,
      ['client_to_agent', promptRequest(3, 'status?')],
      ['agent_to_client', chunk('msg_1', 'The build is green.')],
      ['agent_to_client', promptResult(3)],
    );
    const turn = latestAcpTurnCompletion(envelopes);
    if (!turn) throw new Error('the log has no completed turn to speak');
    expect(acpSpokenAnswer(envelopes, turn, { acpSessionId: null, maxChars: 1_200 })).toBe(
      'The build is green.',
    );
  });

  test('streamed chunks of one message are joined', () => {
    const envelopes = log(
      ...HANDSHAKE,
      ['client_to_agent', promptRequest(3, 'status?')],
      ['agent_to_client', chunk('msg_1', 'The build ')],
      ['agent_to_client', chunk('msg_1', 'is green.')],
      ['agent_to_client', promptResult(3)],
    );
    expect(spoken(envelopes)).toBe('The build is green.');
  });

  test('two session/load replays after the turn cannot be read aloud again', () => {
    const answer = 'The build is green.';
    const envelopes = log(
      ...HANDSHAKE,
      ['client_to_agent', promptRequest(3, 'status?')],
      ['agent_to_client', chunk('msg_1', answer)],
      ['agent_to_client', promptResult(3)],
      [
        'client_to_agent',
        { jsonrpc: '2.0', id: 4, method: 'session/load', params: { sessionId: 'ses_1' } },
      ],
      ['agent_to_client', chunk('msg_1', answer)],
      ['agent_to_client', { jsonrpc: '2.0', id: 4, result: {} }],
      [
        'client_to_agent',
        { jsonrpc: '2.0', id: 5, method: 'session/load', params: { sessionId: 'ses_1' } },
      ],
      ['agent_to_client', chunk('msg_1', answer)],
      ['agent_to_client', { jsonrpc: '2.0', id: 5, result: {} }],
    );
    expect(spoken(envelopes)).toBe(answer);
  });

  test('a turn that only ran tools has nothing to say', () => {
    const envelopes = log(
      ...HANDSHAKE,
      ['client_to_agent', promptRequest(3, 'run the tests')],
      [
        'agent_to_client',
        {
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'ses_1',
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'call_1',
              kind: 'execute',
              status: 'completed',
            },
          },
        },
      ],
      ['agent_to_client', promptResult(3)],
    );
    expect(spoken(envelopes)).toBe('');
  });

  test('another project session hosted on the same server is never spliced in', () => {
    const envelopes = log(
      ...HANDSHAKE,
      ['client_to_agent', promptRequest(3, 'status?')],
      [
        'agent_to_client',
        {
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'ses_other',
            update: {
              sessionUpdate: 'agent_message_chunk',
              messageId: 'msg_x',
              content: { type: 'text', text: 'someone else' },
            },
          },
        },
      ],
      ['agent_to_client', chunk('msg_1', 'The build is green.')],
      ['agent_to_client', promptResult(3)],
    );
    expect(spoken(envelopes)).toBe('The build is green.');
  });

  test('a long answer is truncated to what a room can hear', () => {
    const envelopes = log(
      ...HANDSHAKE,
      ['client_to_agent', promptRequest(3, 'explain everything')],
      ['agent_to_client', chunk('msg_1', 'x'.repeat(40))],
      ['agent_to_client', promptResult(3)],
    );
    const text = spoken(envelopes, 10);
    expect(text).toHaveLength(10);
    expect(text.endsWith('…')).toBe(true);
  });
});

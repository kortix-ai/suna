import { describe, expect, test } from 'bun:test';

import { narrowAcpEnvelopeRows } from './acp-envelope-rows';

function row(direction: string, ordinal: number) {
  return {
    ordinal,
    direction,
    streamEventId: null,
    envelope: { jsonrpc: '2.0', method: 'session/update' },
    createdAt: new Date('2026-07-15T00:00:00.000Z'),
  };
}

describe('narrowAcpEnvelopeRows', () => {
  test('passes through valid directions, converting createdAt to an ISO string', () => {
    const rows = [row('client_to_agent', 1), row('agent_to_client', 2)];
    const result = narrowAcpEnvelopeRows(rows);
    expect(result).toEqual([
      {
        ordinal: 1,
        direction: 'client_to_agent',
        streamEventId: null,
        envelope: { jsonrpc: '2.0', method: 'session/update' },
        createdAt: '2026-07-15T00:00:00.000Z',
      },
      {
        ordinal: 2,
        direction: 'agent_to_client',
        streamEventId: null,
        envelope: { jsonrpc: '2.0', method: 'session/update' },
        createdAt: '2026-07-15T00:00:00.000Z',
      },
    ]);
  });

  test('drops rows with a bogus direction rather than throwing', () => {
    const rows = [row('client_to_agent', 1), row('sideways', 2), row('agent_to_client', 3)];
    const result = narrowAcpEnvelopeRows(rows);
    expect(result.map((r) => r.ordinal)).toEqual([1, 3]);
  });

  test('returns an empty array for an empty input', () => {
    expect(narrowAcpEnvelopeRows([])).toEqual([]);
  });

  test('preserves a non-null streamEventId', () => {
    const result = narrowAcpEnvelopeRows([{ ...row('agent_to_client', 1), streamEventId: 42 }]);
    expect(result[0]?.streamEventId).toBe(42);
  });
});

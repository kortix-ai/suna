import { describe, expect, test } from 'bun:test';

import { isAcpPromptEnvelope } from './acp-envelope';

describe('isAcpPromptEnvelope', () => {
  test('matches only a JSON-RPC session/prompt request', () => {
    expect(isAcpPromptEnvelope({ jsonrpc: '2.0', id: 1, method: 'session/prompt', params: {} })).toBe(true);
    expect(isAcpPromptEnvelope({ jsonrpc: '2.0', id: 2, method: 'session/new', params: {} })).toBe(false);
    expect(isAcpPromptEnvelope({ jsonrpc: '2.0', method: 'session/update', params: {} })).toBe(false);
    expect(isAcpPromptEnvelope(null)).toBe(false);
  });
});

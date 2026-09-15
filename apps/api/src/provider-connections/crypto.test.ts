import { describe, expect, mock, test } from 'bun:test';
mock.module('../config', () => ({ config: { API_KEY_SECRET: 'test-only-personal-provider-encryption-root' } }));
const { seal, unseal } = await import('./crypto');

describe('personal provider credential envelope', () => {
  test('round-trips without exposing plaintext and uses a fresh nonce', () => {
    const first = seal('alice', 'codex', 'credential', 'private-token');
    expect(first).not.toContain('private-token');
    expect(first).not.toBe(seal('alice', 'codex', 'credential', 'private-token'));
    expect(unseal('alice', 'codex', 'credential', first)).toBe('private-token');
  });
  test('rejects another user, provider, purpose, and tampered ciphertext', () => {
    const envelope = seal('alice', 'codex', 'credential', 'private-token');
    expect(() => unseal('bob', 'codex', 'credential', envelope)).toThrow();
    expect(() => unseal('alice', 'openai', 'credential', envelope)).toThrow();
    expect(() => unseal('alice', 'codex', 'flow', envelope)).toThrow();
    expect(() => unseal('alice', 'codex', 'credential', envelope.replace('v1:', 'v2:'))).toThrow();
    const parts = envelope.split(':'); parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => unseal('alice', 'codex', 'credential', parts.join(':'))).toThrow();
  });
});

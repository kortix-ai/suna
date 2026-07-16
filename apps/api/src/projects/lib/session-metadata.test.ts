import { describe, expect, test } from 'bun:test';
import { resolveSessionMetadataModel } from './session-metadata';

// Persisted-session fixtures — pins the dual-read precedence so a future
// change can't silently strand the ~400k session rows written before the
// opencode_model → model rename.
describe('resolveSessionMetadataModel', () => {
  test('a pre-rename row with ONLY opencode_model resolves exactly as today', () => {
    const legacyRow = { existing: true, opencode_model: 'anthropic/claude-opus-4-8' };
    expect(resolveSessionMetadataModel(legacyRow)).toBe('anthropic/claude-opus-4-8');
  });

  test('a new-style row with ONLY model resolves it', () => {
    const neutralRow = { existing: true, model: 'kortix/glm-5.2' };
    expect(resolveSessionMetadataModel(neutralRow)).toBe('kortix/glm-5.2');
  });

  test('both keys present: model (neutral) wins — pins current precedence', () => {
    const bothRow = { model: 'kortix/glm-5.2', opencode_model: 'anthropic/claude-opus-4-8' };
    expect(resolveSessionMetadataModel(bothRow)).toBe('kortix/glm-5.2');
  });

  test('neither key present → null', () => {
    expect(resolveSessionMetadataModel({ existing: true })).toBeNull();
  });

  test('null/undefined metadata → null', () => {
    expect(resolveSessionMetadataModel(null)).toBeNull();
    expect(resolveSessionMetadataModel(undefined)).toBeNull();
  });

  test('non-string values on either key are ignored, not coerced', () => {
    expect(resolveSessionMetadataModel({ model: 42 })).toBeNull();
    expect(resolveSessionMetadataModel({ opencode_model: null })).toBeNull();
    expect(resolveSessionMetadataModel({ model: null, opencode_model: 'anthropic/claude-opus-4-8' })).toBe(
      'anthropic/claude-opus-4-8',
    );
  });
});

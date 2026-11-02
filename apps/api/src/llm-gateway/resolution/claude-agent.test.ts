import { describe, expect, test } from 'bun:test';
import { checkClaudeAgentRef } from './claude-agent';
import { toOpencodeModelRef, toWireModel } from './effective';
import { validateModelChangeShape } from '../../projects/lib/session-model-change';

describe('Claude subscription model refs', () => {
  test('a known id is valid and is stored and booted as-is', () => {
    expect(checkClaudeAgentRef('claude-agent/opus')).toEqual({ kind: 'valid', ref: 'claude-agent/opus' });
    expect(toOpencodeModelRef('claude-agent/sonnet')).toBe('claude-agent/sonnet');
    expect(toWireModel('claude-agent/haiku')).toBe('claude-agent/haiku');
    expect(validateModelChangeShape('claude-agent/fable')).toBeNull();
  });

  test('an unknown id is refused with the list of valid ids', () => {
    const check = checkClaudeAgentRef('claude-agent/gpt-9');
    expect(check.kind).toBe('invalid');
    const expected = '"claude-agent/gpt-9" is not a Claude subscription model. Use one of: claude-agent/opus, claude-agent/fable, claude-agent/sonnet, claude-agent/haiku.';
    expect(check).toEqual({ kind: 'invalid', message: expected });
    expect(validateModelChangeShape('claude-agent/gpt-9')).toEqual({ code: 'INVALID_SESSION_MODEL', message: expected });
    expect(checkClaudeAgentRef('claude-agent/').kind).toBe('invalid');
  });

  test('another provider ref is not a Claude subscription ref and keeps the gateway form', () => {
    expect(checkClaudeAgentRef('kortix/glm-5.3-flash')).toEqual({ kind: 'none' });
    expect(checkClaudeAgentRef('anthropic/claude-opus-5-5')).toEqual({ kind: 'none' });
    expect(toOpencodeModelRef('anthropic/claude-opus-5-5')).toBe('kortix/anthropic/claude-opus-5-5');
  });
});

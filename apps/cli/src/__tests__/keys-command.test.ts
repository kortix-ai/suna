import { describe, expect, test } from 'bun:test';
import { actsAsLabel, parseActsAs } from '../commands/keys.ts';

describe('kortix keys --as', () => {
  test('me is the default; agent:<name> and bot:<name> name the principal', () => {
    expect(parseActsAs(undefined)).toEqual({ type: 'me' });
    expect(parseActsAs('me')).toEqual({ type: 'me' });
    expect(parseActsAs('agent:reporter')).toEqual({ type: 'agent', agent: 'reporter' });
    expect(parseActsAs(' bot: github-actions ')).toEqual({ type: 'bot', bot: 'github-actions' });
  });

  test('anything else is refused', () => {
    for (const bad of ['agent', 'agent:', 'bot:', 'person:ana', 'reporter']) expect(parseActsAs(bad)).toBeNull();
  });

  test('the ACTS AS column', () => {
    expect(actsAsLabel({ type: 'me', name: null })).toBe('you');
    expect(actsAsLabel({ type: 'agent', name: 'reporter' })).toBe('agent:reporter');
    expect(actsAsLabel({ type: 'bot', name: 'ci' })).toBe('bot:ci');
  });
});

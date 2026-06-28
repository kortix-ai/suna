import { describe, expect, test } from 'bun:test';
import { chooseDefaultModel } from './choose-default-model';

describe('chooseDefaultModel', () => {
  test('per-agent default wins over the account default', () => {
    expect(
      chooseDefaultModel({
        accountDefault: 'glm-5.2',
        agentDefaults: { kortix: 'claude-opus-4.8' },
        agentName: 'kortix',
      }),
    ).toBe('claude-opus-4.8');
  });

  test('falls back to the account default when the agent has none', () => {
    expect(
      chooseDefaultModel({
        accountDefault: 'glm-5.2',
        agentDefaults: { 'pr-bot': 'claude-opus-4.8' },
        agentName: 'kortix',
      }),
    ).toBe('glm-5.2');
  });

  test('falls back to the account default when no agent name is given', () => {
    expect(
      chooseDefaultModel({
        accountDefault: 'glm-5.2',
        agentDefaults: { kortix: 'claude-opus-4.8' },
      }),
    ).toBe('glm-5.2');
  });

  test('returns undefined (→ platform default) when nothing is configured', () => {
    expect(
      chooseDefaultModel({ accountDefault: null, agentDefaults: {}, agentName: 'kortix' }),
    ).toBeUndefined();
  });

  test('free tier: a managed default is dropped (managed resolution 400s for them)', () => {
    expect(
      chooseDefaultModel({
        accountDefault: 'claude-opus-4.8',
        agentDefaults: {},
        freeModelsOnly: true,
      }),
    ).toBeUndefined();
  });

  test('free tier: a managed default is dropped even when kortix/-prefixed', () => {
    expect(
      chooseDefaultModel({
        accountDefault: 'kortix/glm-5.2',
        agentDefaults: {},
        freeModelsOnly: true,
      }),
    ).toBeUndefined();
  });

  test('free tier: a BYOK default is KEPT (resolves via the user\'s own key)', () => {
    expect(
      chooseDefaultModel({
        accountDefault: 'anthropic/claude-sonnet-4.6',
        agentDefaults: {},
        freeModelsOnly: true,
      }),
    ).toBe('anthropic/claude-sonnet-4.6');
  });

  test('free tier: a managed per-agent default is dropped, not silently downgraded', () => {
    expect(
      chooseDefaultModel({
        accountDefault: 'anthropic/claude-sonnet-4.6',
        agentDefaults: { kortix: 'glm-5.2' },
        agentName: 'kortix',
        freeModelsOnly: true,
      }),
    ).toBeUndefined();
  });

  test('paid tier: a managed default is kept', () => {
    expect(
      chooseDefaultModel({
        accountDefault: 'claude-opus-4.8',
        agentDefaults: {},
        freeModelsOnly: false,
      }),
    ).toBe('claude-opus-4.8');
  });
});

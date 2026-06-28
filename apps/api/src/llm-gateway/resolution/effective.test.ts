import { describe, expect, test } from 'bun:test';
import {
  chooseEffectiveAgent,
  chooseEffectiveModel,
  toOpencodeModelRef,
  toWireModel,
} from './effective';

describe('chooseEffectiveModel', () => {
  test('most-specific layer wins: agent → project → account', () => {
    expect(
      chooseEffectiveModel({
        agentDefault: 'claude-opus-4.8',
        projectDefault: 'glm-5.2',
        accountDefault: 'qwen3.7-max',
      }),
    ).toEqual({ model: 'claude-opus-4.8', source: 'agent' });
  });

  test('project default wins over account when no agent default', () => {
    expect(
      chooseEffectiveModel({ projectDefault: 'glm-5.2', accountDefault: 'qwen3.7-max' }),
    ).toEqual({ model: 'glm-5.2', source: 'project' });
  });

  test('account default applies when nothing more specific', () => {
    expect(chooseEffectiveModel({ accountDefault: 'qwen3.7-max' })).toEqual({
      model: 'qwen3.7-max',
      source: 'account',
    });
  });

  test('nothing configured → platform default', () => {
    expect(chooseEffectiveModel({})).toEqual({ model: null, source: 'platform' });
  });

  test('free tier: a managed chosen candidate drops to platform (not downgraded)', () => {
    // agent (managed) is most specific → dropped entirely, does NOT fall through
    // to the account BYOK default.
    expect(
      chooseEffectiveModel({
        agentDefault: 'glm-5.2',
        accountDefault: 'anthropic/claude-sonnet-4.6',
        freeModelsOnly: true,
      }),
    ).toEqual({ model: null, source: 'platform' });
  });

  test('free tier: a kortix/-prefixed managed default is also dropped', () => {
    expect(
      chooseEffectiveModel({ projectDefault: 'kortix/glm-5.2', freeModelsOnly: true }),
    ).toEqual({ model: null, source: 'platform' });
  });

  test('free tier: a BYOK project default is kept', () => {
    expect(
      chooseEffectiveModel({ projectDefault: 'anthropic/claude-sonnet-4.6', freeModelsOnly: true }),
    ).toEqual({ model: 'anthropic/claude-sonnet-4.6', source: 'project' });
  });
});

describe('toWireModel / toOpencodeModelRef', () => {
  test('strips the opencode-only kortix/ prefix to the bare wire id', () => {
    expect(toWireModel('kortix/claude-sonnet-4.6')).toBe('claude-sonnet-4.6');
    expect(toWireModel('anthropic/claude-sonnet-4.6')).toBe('anthropic/claude-sonnet-4.6');
    expect(toWireModel('glm-5.2')).toBe('glm-5.2');
  });

  test('re-prefixes a bare managed id to the opencode ref; leaves BYOK/codex alone', () => {
    expect(toOpencodeModelRef('glm-5.2')).toBe('kortix/glm-5.2');
    expect(toOpencodeModelRef('claude-opus-4.8')).toBe('kortix/claude-opus-4.8');
    expect(toOpencodeModelRef('kortix/glm-5.2')).toBe('kortix/glm-5.2');
    expect(toOpencodeModelRef('anthropic/claude-sonnet-4.6')).toBe('anthropic/claude-sonnet-4.6');
    expect(toOpencodeModelRef('codex/gpt-5.5')).toBe('codex/gpt-5.5');
  });

  test('round-trips a managed id through wire → opencode', () => {
    expect(toOpencodeModelRef(toWireModel('kortix/glm-5.2'))).toBe('kortix/glm-5.2');
  });
});

describe('chooseEffectiveAgent', () => {
  test('explicit override wins', () => {
    expect(chooseEffectiveAgent({ explicit: 'reviewer', projectDefault: 'builder' })).toEqual({
      agent: 'reviewer',
      source: 'explicit',
    });
  });

  test('project default applies when no explicit', () => {
    expect(chooseEffectiveAgent({ projectDefault: 'builder' })).toEqual({
      agent: 'builder',
      source: 'project',
    });
  });

  test("falls back to 'default'", () => {
    expect(chooseEffectiveAgent({})).toEqual({ agent: 'default', source: 'fallback' });
  });
});

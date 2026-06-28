import { describe, expect, test } from 'bun:test';
import { modelKeyToWire, wireToModelKey } from './use-model-store';

// The gateway wire model is what opencode sends as body.model and what the
// model-defaults store persists. These conversions keep the picker's ModelKey
// and the stored/sent wire model in sync.
describe('modelKeyToWire', () => {
  test('managed model under the kortix provider → bare modelID', () => {
    expect(modelKeyToWire({ providerID: 'kortix', modelID: 'glm-5.2' })).toBe('glm-5.2');
  });

  test('BYOK under the kortix provider → the provider/model modelID verbatim', () => {
    expect(
      modelKeyToWire({ providerID: 'kortix', modelID: 'anthropic/claude-sonnet-4.6' }),
    ).toBe('anthropic/claude-sonnet-4.6');
  });

  test('a direct provider model → provider/model', () => {
    expect(modelKeyToWire({ providerID: 'anthropic', modelID: 'claude-x' })).toBe(
      'anthropic/claude-x',
    );
  });

  test('opencode native model → bare modelID', () => {
    expect(modelKeyToWire({ providerID: 'opencode', modelID: 'deepseek-v4-flash-free' })).toBe(
      'deepseek-v4-flash-free',
    );
  });
});

describe('wireToModelKey', () => {
  test('maps a bare managed id under the kortix provider', () => {
    expect(wireToModelKey('glm-5.2')).toEqual({ providerID: 'kortix', modelID: 'glm-5.2' });
  });

  test('maps a BYOK provider/model under the kortix provider namespace', () => {
    expect(wireToModelKey('anthropic/claude-sonnet-4.6')).toEqual({
      providerID: 'kortix',
      modelID: 'anthropic/claude-sonnet-4.6',
    });
  });

  test('round-trips a kortix model key', () => {
    const key = { providerID: 'kortix', modelID: 'glm-5.2' };
    expect(wireToModelKey(modelKeyToWire(key))).toEqual(key);
  });
});

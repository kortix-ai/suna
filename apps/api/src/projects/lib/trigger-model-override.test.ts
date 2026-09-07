import { describe, expect, test } from 'bun:test';
import { triggerModelOverride } from './triggers';

describe('triggerModelOverride', () => {
  test('a wire ref becomes the prompt override OpenCode expects', () => {
    expect(triggerModelOverride('codex/gpt-5.6-luna')).toEqual({ model: { providerID: 'kortix', modelID: 'codex/gpt-5.6-luna' } });
    expect(triggerModelOverride('kortix/glm-5.2')).toEqual({ model: { providerID: 'kortix', modelID: 'glm-5.2' } });
    expect(triggerModelOverride('glm-5.3-flash')).toEqual({ model: { providerID: 'kortix', modelID: 'glm-5.3-flash' } });
  });
  test('no model = no override (the session default applies)', () => {
    expect(triggerModelOverride(null)).toBeUndefined();
    expect(triggerModelOverride('')).toBeUndefined();
    expect(triggerModelOverride('  ')).toBeUndefined();
  });
});

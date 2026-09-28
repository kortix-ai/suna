/**
 * The pure half of the open-path retired-model repair.
 *
 * `repairRetiredSessionModelOnOpen` itself is IO all the way down (gateway
 * flag, entitlements, the re-point write, the daemon push), so what is pinned
 * here is the predicate that decides whether ANY of that IO happens — the one
 * thing every healthy session open executes.
 */

import { describe, expect, test } from 'bun:test';

import { pinNeedsRepair, storedPinWireId } from './session-model-repair';

describe('storedPinWireId', () => {
  test('strips the synthetic kortix/ provider prefix', () => {
    expect(storedPinWireId({ opencode_model: 'kortix/deepseek-v4-flash' })).toBe(
      'deepseek-v4-flash',
    );
  });

  test('leaves a bare id alone', () => {
    expect(storedPinWireId({ opencode_model: 'deepseek-v4-flash' })).toBe('deepseek-v4-flash');
  });

  test('is null for a session with no pin', () => {
    expect(storedPinWireId({})).toBeNull();
    expect(storedPinWireId(null)).toBeNull();
    expect(storedPinWireId({ opencode_model: '' })).toBeNull();
    expect(storedPinWireId({ opencode_model: 42 })).toBeNull();
  });
});

describe('pinNeedsRepair', () => {
  // The two shapes measured on a real project, 2026-09-28: 88 sessions on a
  // retired id WITH a successor, 20 on a retired id with none. Both are dead
  // turns, so both must be repaired.
  test.each([
    ['kortix/deepseek-v4-flash', 'retired, has a declared successor'],
    ['kortix/glm-5.2', 'retired, no declared successor'],
    ['kortix/grok-4.6', 'retired, no declared successor'],
  ])('%s is repaired (%s)', (pin) => {
    expect(pinNeedsRepair({ opencode_model: pin })).toBe(true);
  });

  test('a servable managed pin is left alone', () => {
    expect(pinNeedsRepair({ opencode_model: 'kortix/deepseek-v4.1-flash' })).toBe(false);
  });

  test('a BYOK ref is left alone', () => {
    expect(pinNeedsRepair({ opencode_model: 'anthropic/claude-sonnet-5' })).toBe(false);
    expect(pinNeedsRepair({ opencode_model: 'kortix/openrouter/z-ai/glm-5.3-flash' })).toBe(false);
  });

  test('a session with no pin is left alone — the fast path', () => {
    expect(pinNeedsRepair(null)).toBe(false);
    expect(pinNeedsRepair({})).toBe(false);
  });
});

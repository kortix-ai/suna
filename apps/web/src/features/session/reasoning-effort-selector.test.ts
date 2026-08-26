import { describe, expect, test } from 'bun:test';

import { reasoningEffortChoices } from './reasoning-effort-selector';

describe('reasoningEffortChoices — the composer thinking control show/hide rule', () => {
  test('no variants → hidden (empty), in either mode', () => {
    expect(reasoningEffortChoices(undefined, true)).toEqual([]);
    expect(reasoningEffortChoices([], true)).toEqual([]);
  });

  test('variants but no way to apply one (no runtime model store) → hidden', () => {
    expect(reasoningEffortChoices(['low', 'high'], false)).toEqual([]);
  });

  test("offers the model's OWN ids in the model's own order — never a hardcoded ladder", () => {
    expect(reasoningEffortChoices(['none', 'low', 'medium', 'high', 'xhigh', 'max'], true)).toEqual(
      ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    );
    expect(reasoningEffortChoices(['high', 'max'], true)).toEqual(['high', 'max']);
  });

  test('a runtime/catalog merge slip that repeats an id collapses to one entry', () => {
    expect(reasoningEffortChoices(['low', 'low', 'high', ''], true)).toEqual(['low', 'high']);
  });
});

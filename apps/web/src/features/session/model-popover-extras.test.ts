import { describe, expect, test } from 'bun:test';

import { computeModelExtrasRows } from './model-popover-extras';

describe('computeModelExtrasRows', () => {
  test('no variants, no project → nothing shows (the 8 non-composer ModelSelector call sites)', () => {
    const rows = computeModelExtrasRows({
      variants: [],
      hasVariantHandler: false,
      reasoningEffortValues: [],
      hasProjectId: false,
    });
    expect(rows).toEqual({
      showVariantRow: false,
      showReasoningEffortRow: false,
      showSection: false,
    });
  });

  test('variants present but no handler wired → variant row stays hidden', () => {
    const rows = computeModelExtrasRows({
      variants: ['thinking', 'fast'],
      hasVariantHandler: false,
      reasoningEffortValues: [],
      hasProjectId: false,
    });
    expect(rows.showVariantRow).toBe(false);
    expect(rows.showSection).toBe(false);
  });

  test('variants + handler → variant row shows, section shows', () => {
    const rows = computeModelExtrasRows({
      variants: ['thinking', 'fast'],
      hasVariantHandler: true,
      reasoningEffortValues: [],
      hasProjectId: false,
    });
    expect(rows).toEqual({
      showVariantRow: true,
      showReasoningEffortRow: false,
      showSection: true,
    });
  });

  test('reasoning-effort values present but no projectId → row stays hidden', () => {
    const rows = computeModelExtrasRows({
      variants: [],
      hasVariantHandler: false,
      reasoningEffortValues: ['low', 'medium', 'high'],
      hasProjectId: false,
    });
    expect(rows.showReasoningEffortRow).toBe(false);
    expect(rows.showSection).toBe(false);
  });

  test('projectId present but model has no reasoning-effort values → row stays hidden', () => {
    const rows = computeModelExtrasRows({
      variants: [],
      hasVariantHandler: false,
      reasoningEffortValues: [],
      hasProjectId: true,
    });
    expect(rows.showReasoningEffortRow).toBe(false);
    expect(rows.showSection).toBe(false);
  });

  test('projectId + reasoning-effort values → row shows, section shows', () => {
    const rows = computeModelExtrasRows({
      variants: [],
      hasVariantHandler: false,
      reasoningEffortValues: ['low', 'medium', 'high'],
      hasProjectId: true,
    });
    expect(rows).toEqual({
      showVariantRow: false,
      showReasoningEffortRow: true,
      showSection: true,
    });
  });

  test('both variant and reasoning-effort eligible → both rows show', () => {
    const rows = computeModelExtrasRows({
      variants: ['thinking'],
      hasVariantHandler: true,
      reasoningEffortValues: ['low', 'high'],
      hasProjectId: true,
    });
    expect(rows).toEqual({
      showVariantRow: true,
      showReasoningEffortRow: true,
      showSection: true,
    });
  });
});

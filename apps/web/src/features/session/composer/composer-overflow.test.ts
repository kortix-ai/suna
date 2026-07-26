import { describe, expect, test } from 'bun:test';

import { hasComposerOverflowContent } from './composer-overflow';

const NONE = {
  showAgent: false,
  showModel: false,
  showVariant: false,
  showReasoningEffort: false,
};

describe('hasComposerOverflowContent', () => {
  test('false when nothing would render', () => {
    expect(hasComposerOverflowContent(NONE)).toBe(false);
  });

  test('true when only the agent selector would render', () => {
    expect(hasComposerOverflowContent({ ...NONE, showAgent: true })).toBe(true);
  });

  test('true when only the model selector would render', () => {
    expect(hasComposerOverflowContent({ ...NONE, showModel: true })).toBe(true);
  });

  test('true when only the variant selector would render', () => {
    expect(hasComposerOverflowContent({ ...NONE, showVariant: true })).toBe(true);
  });

  test('true when only reasoning effort would render', () => {
    expect(hasComposerOverflowContent({ ...NONE, showReasoningEffort: true })).toBe(true);
  });

  test('true when everything would render', () => {
    expect(
      hasComposerOverflowContent({
        showAgent: true,
        showModel: true,
        showVariant: true,
        showReasoningEffort: true,
      }),
    ).toBe(true);
  });
});

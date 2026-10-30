import { describe, expect, test } from 'bun:test';

import { diffRendererViewportClass } from './change-request-detail-dialog';

describe('change request diff renderer sizing', () => {
  test('keeps split diffs horizontally scrollable below the desktop layout', () => {
    expect(diffRendererViewportClass('split')).toBe('min-w-[860px] lg:min-w-0');
    expect(diffRendererViewportClass('split')).not.toContain('sm:min-w-0');
  });

  test('lets unified diffs collapse earlier than split diffs', () => {
    expect(diffRendererViewportClass('unified')).toBe('min-w-[680px] sm:min-w-0');
  });
});

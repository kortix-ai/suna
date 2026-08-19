import { describe, expect, test } from 'bun:test';

import {
  SHARE_FILE_IFRAME_CLASS,
  SHARE_PAGE_ROOT_CLASS,
  SHARE_PREVIEW_IFRAME_CLASS,
} from './share-layout';

describe('public session share layout sizing', () => {
  test('page root pins a definite viewport height, not a minimum', () => {
    // A min-height does not give `h-full` / `flex-1` descendants a definite
    // height to resolve against, which collapses the embedded iframe. The root
    // must therefore be a definite viewport height.
    expect(SHARE_PAGE_ROOT_CLASS).toContain('h-dvh');
    expect(SHARE_PAGE_ROOT_CLASS).not.toContain('min-h-screen');
    expect(SHARE_PAGE_ROOT_CLASS).toContain('flex-col');
  });

  test('preview iframe fills the region full width and full height', () => {
    expect(SHARE_PREVIEW_IFRAME_CLASS).toContain('h-full');
    expect(SHARE_PREVIEW_IFRAME_CLASS).toContain('w-full');
  });

  test('html file iframe fills the region full width and full height', () => {
    // The share view no longer stacks a toolbar above the document, so this
    // iframe is the only child of the content region and claims the whole box
    // exactly like the preview iframe.
    expect(SHARE_FILE_IFRAME_CLASS).toContain('h-full');
    expect(SHARE_FILE_IFRAME_CLASS).toContain('w-full');
  });

  test('every iframe class claims the full width so content is never clipped', () => {
    for (const cls of [SHARE_PREVIEW_IFRAME_CLASS, SHARE_FILE_IFRAME_CLASS]) {
      expect(cls).toContain('w-full');
      // full height comes from either an explicit h-full or flex-1 growth
      expect(cls.includes('h-full') || cls.includes('flex-1')).toBe(true);
    }
  });
});

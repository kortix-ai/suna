import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('./project-home.tsx', import.meta.url)), 'utf8');

describe('ProjectHome sidebar toggle', () => {
  test('connects collapsed-toggle hover to the sidebar peek controller', () => {
    expect(source).toContain('onPointerEnter={sidebarState ===');
    expect(source).toContain('peekEnter');
    expect(source).toContain('peekLeave');
  });

  // Visibility is not this view's decision any more. It used to inline
  // `isMobileViewport || sidebarState !== 'expanded'`, which is also true on
  // the desktop shell — so this button, `absolute top-2 left-2`, rendered on
  // top of the macOS traffic lights next to the shell's own opener at x=72.
  // The rule (including that desktop clause) is pinned as a truth table in
  // sidebar-opener.test.ts; here we only pin that the view defers to it.
  test('visibility comes from the shared gate, not a local rule', () => {
    const gate = source.slice(
      source.indexOf('const showSidebarToggle ='),
      source.indexOf(';', source.indexOf('const showSidebarToggle =')),
    );
    expect(gate).toContain('useShowPageSidebarOpener()');
    expect(source).toContain('{showSidebarToggle && (');
  });

  test('does not send the project default as an explicit session sandbox override', () => {
    expect(source).not.toContain('sandbox_slug: activeSlug');
  });
});

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('./project-home.tsx', import.meta.url)), 'utf8');

describe('ProjectHome sidebar toggle', () => {
  test('uses the shared toggle instead of a hand-rolled one', () => {
    // The shared control hides itself while the sidebar is open, because the
    // panel carries its own collapse button in its header. A local copy here
    // put two identical buttons a few pixels apart on the project home.
    expect(source).toContain('<SidebarPeekToggle');
    expect(source).not.toContain('onPointerEnter={sidebarState ===');
  });

  test('does not send the project default as an explicit session sandbox override', () => {
    expect(source).not.toContain('sandbox_slug: activeSlug');
  });
});

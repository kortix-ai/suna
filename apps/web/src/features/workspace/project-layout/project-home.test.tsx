import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('./project-home.tsx', import.meta.url)), 'utf8');

describe('ProjectHome sidebar toggle', () => {
  test('renders no sidebar toggle — the shell owns it', () => {
    // ShellInset renders the single reopener; the sidebar header carries the
    // collapse control. A copy here was one of the duplicates.
    expect(source).not.toContain('SidebarPeekToggle');
    expect(source).not.toContain('onPointerEnter={sidebarState ===');
  });

  test('does not send the project default as an explicit session sandbox override', () => {
    expect(source).not.toContain('sandbox_slug: activeSlug');
  });
});

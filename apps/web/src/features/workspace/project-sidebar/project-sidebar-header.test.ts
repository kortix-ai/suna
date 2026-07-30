import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The sidebar header row: Kortix home link + the panel's own collapse toggle.
 * The project switcher used to sit here and no longer does.
 *
 * Asserted against the source because the alternative is mounting the whole
 * sidebar (sidebar + auth + query + i18n providers) to observe which controls
 * one header row renders.
 */
const source = readFileSync(join(import.meta.dir, 'project-sidebar.tsx'), 'utf8');

const header = source.slice(source.indexOf('<SidebarHeader'), source.indexOf('</SidebarHeader>'));

describe('project sidebar header', () => {
  test('the project switcher is gone', () => {
    expect(source).not.toContain('<ProjectSwitcher');
    expect(source).not.toContain("from '@/features/workspace/project-sidebar/project-switcher'");
  });

  test('the collapse toggle took its place', () => {
    expect(header).toContain('onClick={toggleSidebar}');
    expect(header).toContain('<PanelLeft');
    expect(header).toContain("aria-label={isExpanded ? 'Collapse sidebar' : 'Pin sidebar'}");
  });

  // ⌘K is otherwise the palette's only entry point, which is invisible to
  // anyone who does not already know it exists.
  test('a search control opens the command palette', () => {
    expect(header).toContain('aria-label="Search"');
    expect(header).toContain('<MagnifyingGlassIcon');
    expect(header).toContain('onClick={handleOpenSearch}');
    expect(source).toContain('openCommandPalette()');
  });

  // No keystroke exists on touch, so the button is the only way in there.
  test('search renders on mobile too, unlike the collapse toggle', () => {
    const search = header.slice(header.indexOf('aria-label="Search"'));
    expect(search.indexOf('{!isMobile && (')).toBeGreaterThan(-1);
    const beforeSearch = header.slice(0, header.indexOf('aria-label="Search"'));
    expect(beforeSearch).not.toContain('{!isMobile && (');
  });

  // Mobile renders the panel as a Sheet: no docked state to collapse, and
  // `state` there still reads the desktop cookie. Same reason the session
  // header's own toggle exempts mobile from its docked-open gate.
  test('the toggle is desktop-only', () => {
    expect(header).toContain('{!isMobile && (');
  });
});

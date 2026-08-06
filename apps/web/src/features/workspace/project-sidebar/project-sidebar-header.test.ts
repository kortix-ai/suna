import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The sidebar header row: the merged brand/switcher control, search, and the
 * panel's own collapse toggle.
 *
 * The Kortix mark used to be its own button next to the switcher. Both answered
 * "which project am I in / where do I go", looked nothing alike, and left dead
 * space between them. They are one segmented control now, owned by
 * WorkspaceSwitcher — the mark keeps its link to the project's home.
 *
 * Asserted against the source because the alternative is mounting the whole
 * sidebar (sidebar + auth + query + i18n providers) to observe which controls
 * one header row renders.
 */
const source = readFileSync(join(import.meta.dir, 'project-sidebar.tsx'), 'utf8');

const header = source.slice(source.indexOf('<SidebarHeader'), source.indexOf('</SidebarHeader>'));

describe('project sidebar header', () => {
  test('the merged brand/switcher control leads the row', () => {
    expect(header).toContain('<WorkspaceSwitcher variant="sidebar"');
  });

  // The whole point of the merge: one control, not a mark button parked beside
  // a switcher. The mark now lives inside WorkspaceSwitcher.
  test('no standalone Kortix mark button is left beside it', () => {
    expect(header).not.toContain('<Icon.Kortix');
  });

  // A `w-fit` trigger inside a full-width wrapper left an inert strip between
  // the project name and search that looked clickable and was not.
  test('the control takes the row, so there is no dead strip beside it', () => {
    expect(header).toContain('className="min-w-0 flex-1"');
    expect(header).not.toContain('max-w-full');
    expect(header).not.toContain('w-fit');
  });

  test('the collapse toggle took the mark button’s place', () => {
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

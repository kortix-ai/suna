import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The sidebar header row: the account control, search, and the panel's own
 * collapse toggle.
 *
 * That first control used to be three. A `<Link>` carrying the Kortix mark was
 * fused to a separate dropdown trigger carrying the workspace name, and the user
 * menu was a third control down in the footer — two of the three being
 * dropdowns, all answering some slice of "who am I / where am I / where can I
 * go". It is one `UserMenu` now: the link is gone, and the workspace directory
 * is a second view of that menu behind "Switch Workspace".
 *
 * Asserted against the source because the alternative is mounting the whole
 * sidebar (sidebar + auth + query + i18n providers) to observe which controls
 * one header row renders.
 */
const source = readFileSync(join(import.meta.dir, 'project-sidebar.tsx'), 'utf8');

const header = source.slice(source.indexOf('<SidebarHeader'), source.indexOf('</SidebarHeader>'));

describe('project sidebar header', () => {
  test('the account control leads the row, and carries the workspace directory', () => {
    expect(header).toContain('<UserMenu user={user} variant="sidebar" showWorkspaces />');
  });

  // The whole point of the merge: one control. Neither the old split brand/name
  // control nor a standalone mark button may come back.
  test('no standalone Kortix mark button and no separate switcher', () => {
    expect(header).not.toContain('<Icon.Kortix');
    expect(header).not.toContain('WorkspaceSwitcher');
  });

  // The user menu was the third control, at the other end of the same panel.
  // One dropdown per panel, not two.
  test('the footer no longer carries a second copy of the same menu', () => {
    expect(source).not.toContain('<SidebarFooter');
    expect(source.match(/<UserMenu/g)?.length).toBe(1);
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

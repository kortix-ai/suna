import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The sidebar header row: the workspace switcher, search, and the panel's own
 * collapse toggle.
 *
 * That first control used to be three. A `<Link>` carrying the dosco mark was
 * fused to a separate dropdown trigger carrying the workspace name, and the user
 * menu was a third control down in the footer — two of the three being
 * dropdowns, all answering some slice of "where am I / where can I go / who am
 * I". It is one `WorkspaceSwitcher` now, named for the question it exists to
 * answer, with the directory behind a "Switch Workspace" submenu.
 *
 * Asserted against the source because the alternative is mounting the whole
 * sidebar (sidebar + auth + query + i18n providers) to observe which controls
 * one header row renders.
 */
const source = readFileSync(join(import.meta.dir, 'project-sidebar.tsx'), 'utf8');

const header = source.slice(source.indexOf('<SidebarHeader'), source.indexOf('</SidebarHeader>'));

/**
 * Comments stripped before the absence checks, same convention as
 * `workspace-vocabulary.test.ts`. This header's own comment explains the old
 * design in prose — "a `<Link>` carrying the dosco mark" — so an unstripped
 * `.not.toContain('<Link')` fails on the explanation of the thing it is
 * checking was removed.
 */
const headerCode = header.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('project sidebar header', () => {
  test('the workspace switcher leads the row', () => {
    expect(header).toContain('<WorkspaceSwitcher projectId={projectId} />');
  });

  // The whole point of the merge: one control. The old split brand/name control
  // and the standalone mark button may not come back.
  test('no standalone dosco mark button beside it', () => {
    expect(headerCode).not.toContain('<Icon.dosco');
    expect(headerCode).not.toContain('<Link');
  });

  // The user menu was the third control, at the other end of the same panel.
  // It belongs to the app header now; the sidebar has exactly one dropdown.
  test('the footer carries no second menu', () => {
    expect(source).not.toContain('<SidebarFooter');
    expect(source).not.toContain('UserMenu');
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

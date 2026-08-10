import { describe, expect, test } from 'bun:test';

import { shouldShowPageSidebarOpener, sidebarOpenerLabel } from './sidebar-opener';

/**
 * One panel, one opener.
 *
 * The workspace sidebar is `collapsible="offcanvas"` — collapsed means gone —
 * so five views grew their own "bring it back" control and each carried its
 * own copy of this rule. Four of them omitted the desktop-shell clause, which
 * is how the macOS build ended up drawing a second opener at `top-2 left-2`,
 * directly on the traffic lights, while the shell's own sat at x=72.
 *
 * The rule is pure now, so the whole truth table is cheap to pin.
 */

const base = { hasSidebar: true, isDesktopShell: false, isMobile: false, state: 'collapsed' };

describe('shouldShowPageSidebarOpener', () => {
  test('undocked on the web: the view draws it', () => {
    expect(shouldShowPageSidebarOpener(base)).toBe(true);
  });

  test('docked on the web: the panel header owns collapse, so the view stands down', () => {
    expect(shouldShowPageSidebarOpener({ ...base, state: 'expanded' })).toBe(false);
  });

  // THE REGRESSION. `isMobile || state !== 'expanded'` — the rule four views
  // actually had — returns true here, which is the duplicate-on-the-lights bug.
  test('desktop shell: never, because the shell draws the only one', () => {
    expect(shouldShowPageSidebarOpener({ ...base, isDesktopShell: true })).toBe(false);
    expect(
      shouldShowPageSidebarOpener({ ...base, isDesktopShell: true, state: 'expanded' }),
    ).toBe(false);
  });

  // A desktop-shell window narrow enough to be "mobile" is a real state: the
  // shell's minWidth is 720 and the sidebar's breakpoint is 768. The shell
  // toggle renders there too, so this must still be false.
  test('desktop shell stays false even at a mobile width', () => {
    expect(
      shouldShowPageSidebarOpener({ ...base, isDesktopShell: true, isMobile: true }),
    ).toBe(false);
  });

  // On mobile the panel is a Sheet, but `state` still reflects the DESKTOP
  // dock cookie. Gating on it would hide the only way into the sheet for any
  // user whose cookie happened to say 'expanded'.
  test('mobile ignores the docked state entirely', () => {
    expect(shouldShowPageSidebarOpener({ ...base, isMobile: true, state: 'expanded' })).toBe(
      true,
    );
  });

  test('no sidebar context: nothing to open', () => {
    expect(shouldShowPageSidebarOpener({ ...base, hasSidebar: false })).toBe(false);
    expect(
      shouldShowPageSidebarOpener({ ...base, hasSidebar: false, isMobile: true }),
    ).toBe(false);
  });
});

describe('sidebarOpenerLabel', () => {
  test('docked: the control collapses', () => {
    expect(sidebarOpenerLabel({ state: 'expanded' })).toBe('Collapse sidebar');
  });

  // Peeking means the panel is already on screen as a hover flyout, so the
  // click docks it. Calling that "Open" reads as a no-op.
  test('peeking: the control pins what is already showing', () => {
    expect(sidebarOpenerLabel({ state: 'collapsed', peek: true })).toBe('Pin sidebar');
  });

  test('hidden: the control opens it', () => {
    expect(sidebarOpenerLabel({ state: 'collapsed', peek: false })).toBe('Open sidebar');
    expect(sidebarOpenerLabel({ state: 'collapsed' })).toBe('Open sidebar');
  });
});

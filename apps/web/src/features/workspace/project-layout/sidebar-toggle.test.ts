import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `SidebarToggle` is THE sidebar opener — one component, rendered by every
 * surface that can be looked at with the panel hidden.
 *
 * There is no React harness in apps/web, so the component's own contract is
 * pinned against its source. The visibility RULE it defers to is separately
 * pinned as a truth table in sidebar-opener.test.ts, and the "every view uses
 * this component" half is pinned in desktop-titlebar.test.ts. This file covers
 * the third piece: that the one implementation still does the things the six
 * copies it replaced each did.
 */
const source = readFileSync(fileURLToPath(new URL('./sidebar-toggle.tsx', import.meta.url)), 'utf8');
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

describe('SidebarToggle', () => {
  // Without this every assertion below degrades to "a string is missing from a
  // file I could not find", which passes for the wrong reason.
  test('the fixture this suite reads is the real component', () => {
    expect(code).toContain('export function SidebarToggle(');
    expect(code).toContain("'use client'");
  });

  // The whole point of collapsing six copies into one: callers place it
  // unconditionally and never re-derive who may draw an opener. If the gate
  // moved back out to the callers, the drift this component ended would start
  // again.
  test('it self-gates on the shared rule and renders nothing when suppressed', () => {
    expect(code).toContain('useShowPageSidebarOpener()');
    expect(code).toContain('if (!sidebar || !show) return null;');
  });

  // `useOptionalSidebar`, not `useSidebar`: the latter throws outside a
  // SidebarProvider, and this renders on surfaces that can mount without one.
  test('it reads the sidebar context without throwing outside a provider', () => {
    expect(code).toContain('useOptionalSidebar()');
    expect(code).not.toContain('useSidebar()');
  });

  // Peek is the collapsed-only hover flyout. Arming it while the panel is
  // docked open would summon a flyout for a panel already on screen.
  test('hover arms the peek controller only while the panel is collapsed', () => {
    expect(code).toContain("const collapsed = sidebar.state === 'collapsed';");
    expect(code).toContain('onPointerEnter={collapsed ? sidebar.peekEnter : undefined}');
    expect(code).toContain('onPointerLeave={collapsed ? sidebar.peekLeave : undefined}');
  });

  // `toggleSidebar` takes an options object. Passing it straight to onClick
  // hands it the MouseEvent as those options — which every copy this component
  // replaced did.
  test('the click calls toggleSidebar with no arguments, not the click event', () => {
    expect(code).toContain('onClick={() => sidebar.toggleSidebar()}');
    expect(code).not.toContain('onClick={sidebar.toggleSidebar}');
  });

  // Four of the six copies wrapped the button in `Hint`; two shipped a bare
  // aria-label. Both, now, on every surface.
  test('the control is labelled for pointer and for assistive tech', () => {
    expect(code).toContain('const label = sidebarOpenerLabel(sidebar);');
    expect(code).toContain('<Hint label={label}');
    expect(code).toContain('aria-label={label}');
  });

  // `floating` is the only placement that positions itself, and it is opt-in:
  // a toggle that absolutely positioned itself by default landed on the macOS
  // traffic lights in the views that wanted it in flow.
  test('absolute positioning is opt-in via placement="floating"', () => {
    expect(code).toContain("placement = 'inline'");
    expect(code).toContain("placement === 'floating' && 'absolute top-2 left-2 z-20'");
    // The base class list — the part every surface gets — must not position.
    const base = code.slice(code.indexOf('className={cn('), code.indexOf("placement === 'floating'"));
    expect(base).not.toContain('absolute');
  });

  // The glyph points at the panel's edge, which is the right edge in RTL.
  test('the icon flips in RTL', () => {
    expect(code).toContain('cn-rtl-flip');
  });
});

/**
 * Two surfaces deliberately keep their own opener because their rule is a
 * different rule, not a drifted copy of this one. Pinned so a future "finish
 * the migration" pass reads the reason instead of guessing.
 */
describe('the two openers that are NOT this component', () => {
  const repoRoot = join(import.meta.dir, '../../../../../..');

  test('project-shell draws the desktop-shell opener, where SidebarToggle is suppressed', () => {
    const shell = readFileSync(join(import.meta.dir, 'project-shell.tsx'), 'utf8');
    // `useShowPageSidebarOpener` returns false on the desktop shell, so this
    // one cannot be SidebarToggle — it would never render.
    expect(shell).toContain('desktopShell && !isExpanded');
  });

  test('the Easy panel opener gates on fullscreen, and mounts with no provider at all', () => {
    const detail = readFileSync(
      join(repoRoot, 'apps/web/src/features/session/action-panel/easy/detail-view.tsx'),
      'utf8',
    );
    expect(detail).toContain('function DetailSidebarToggle');
    expect(detail).toContain('if (!panelFullscreen || isMobile || !sidebar) return null;');
  });
});

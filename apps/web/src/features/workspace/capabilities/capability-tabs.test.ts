import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(
  fileURLToPath(new URL('./capability-tabs.tsx', import.meta.url)),
  'utf8',
);

describe('CapabilityTabs sidebar toggle', () => {
  test('connects collapsed-toggle hover to the sidebar peek controller', () => {
    expect(source).toContain('onPointerEnter={sidebar.state ===');
    expect(source).toContain('peekEnter');
    expect(source).toContain('peekLeave');
  });

  // The panel's own header carries the collapse control (ProjectSidebar), so
  // this page-level toggle exists only to bring a hidden panel back.
  test('the toggle self-hides while the sidebar is docked open', () => {
    expect(source).toContain("sidebar.state === 'expanded'");
    expect(source).toContain('!sidebar.isMobile && sidebar.state ===');
  });

  // `sidebar.state` tracks the desktop dock cookie, not the mobile Sheet — an
  // ungated gate would leave this page with no way to open the sheet.
  test('mobile is exempt from that gate', () => {
    const gate = source.slice(
      source.indexOf('const showSidebarToggle ='),
      source.indexOf(';', source.indexOf('const showSidebarToggle =')),
    );
    expect(gate).toContain('sidebar.isMobile ||');
    expect(gate).toContain("sidebar.state !== 'expanded'");
  });

  test('clears the first tab past the absolute toggle when it is visible', () => {
    expect(source).toContain("showSidebarToggle && 'pl-12'");
  });
});

/**
 * The tab bar is pinned by LAYOUT, not by `position`. Two classes carry that,
 * in two different files, and neither reads as load-bearing on its own — which
 * is exactly why they are pinned here.
 */
describe('CapabilityTabs stays pinned to the top', () => {
  // Comments stripped first. Both files explain the regression in prose that
  // names the class it forbids, so asserting against the raw text would make
  // the explanation fail the test — and deleting the explanation a way to
  // pass it.
  const code = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

  const layout = code(
    readFileSync(
      fileURLToPath(
        new URL('../../../app/(app)/projects/[id]/(capabilities)/layout.tsx', import.meta.url),
      ),
      'utf8',
    ),
  );

  test('the route group layout is a bounded box, not a flex-1 one', () => {
    // `min-h-0 flex-1` was the regression, and it reads correct. Nothing above
    // this box has a definite height — `<body>` is `min-height: 100dvh`,
    // `sidebar-wrapper` is `min-h-svh`, and every shell between them is
    // `flex-1 … overflow-hidden` — so the box sized to its content, the
    // `overflow-y-auto` in `CapabilityPageShell` never engaged, and the window
    // scrolled the tab bar off the top.
    expect(layout).toContain('className="flex h-svh flex-col overflow-hidden"');
    expect(layout).not.toContain('flex-1');
  });

  test('svh, not dvh — a returning mobile toolbar must not push the bar off', () => {
    expect(layout).not.toContain('h-dvh');
  });

  test('the bar cannot be compressed by the page body below it', () => {
    // The layout's other child grows, so this bar is the one item flex would
    // shrink to make room for an overflowing page.
    expect(code(source)).toContain('<div className="relative shrink-0">');
  });

  test('the page body is the only scrolling element, and it is BELOW the bar', () => {
    // If the shell ever stops owning the scroll, or the bar moves inside it,
    // the bar scrolls again — with no `position` anywhere to say why.
    const shell = code(
      readFileSync(fileURLToPath(new URL('./capability-page-shell.tsx', import.meta.url)), 'utf8'),
    );
    expect(shell).toContain('min-h-0 flex-1 overflow-y-auto');
    expect(layout.indexOf('<CapabilityTabs')).toBeLessThan(layout.indexOf('{children}'));
  });

  test('no position hack stands in for the layout', () => {
    // `sticky` here would be a no-op that looks deliberate: `overflow: hidden`
    // makes an element a scroll container, sticky resolves against the nearest
    // ancestor scroll container, and there are five between this bar and the
    // viewport — it would pin to a box that never scrolls.
    expect(code(source)).not.toContain('sticky');
    expect(code(source)).not.toContain('fixed top-0');
  });
});

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(
  fileURLToPath(new URL('./capability-tabs.tsx', import.meta.url)),
  'utf8',
);

const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

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

  // In-flow toggle: when it returns null the tabs just start earlier. Absolute
  // overlay + pl-12 clearance is what caused hit-target collisions before.
  test('the sidebar toggle sits in flow, not absolute over the tabs', () => {
    const body = code(source);
    const toggleStart = body.indexOf('function CapabilitySidebarToggle');
    const toggleEnd = body.indexOf('function GlobalRulesControl');
    const toggle = body.slice(toggleStart, toggleEnd);
    expect(toggle).not.toContain('absolute');
    expect(toggle).not.toContain('pl-12');
  });
});

describe('CapabilityTabs Global rules control', () => {
  test('Global rules open in a Sheet, not a Modal', () => {
    const body = code(source);
    expect(body).toContain('<Sheet open={open}');
    expect(body).toContain('SheetContent');
    expect(body).toContain('Global rules');
    expect(body).toContain('PoliciesPanel');
    expect(body).not.toContain('Modal');
    expect(body).not.toContain("from '@/components/ui/modal'");
  });

  // A labeled button does not need a Hint. Hint + TooltipTrigger wrapping the
  // button is what users saw firing when they thought they were on a tab.
  test('Global rules does not wrap itself in a Hint', () => {
    const body = code(source);
    const start = body.indexOf('function GlobalRulesControl');
    const end = body.indexOf('export function CapabilityTabs');
    const control = body.slice(start, end);
    expect(control).not.toContain('<Hint');
  });

  // `before:absolute before:-inset-*` without `relative` on the button resolves
  // against the bar's `relative` ancestor and paints an invisible hit layer
  // across the entire tab row — stealing clicks from the tab triggers.
  test('Global rules does not expand its hit area with a ::before inset', () => {
    const body = code(source);
    const start = body.indexOf('function GlobalRulesControl');
    const end = body.indexOf('export function CapabilityTabs');
    const control = body.slice(start, end);
    expect(control).not.toContain('before:absolute');
    expect(control).not.toContain('before:-inset');
  });

  test('Global rules sits in flow on the right — no absolute overlay', () => {
    const body = code(source);
    // Assert against the bar itself; SheetHeader uses `pr-12` to clear its
    // own close button, which is unrelated to tab hit targets.
    const barStart = body.indexOf('export function CapabilityTabs');
    const bar = body.slice(barStart);
    expect(bar).not.toContain('absolute');
    expect(bar).not.toContain('pr-12');
    expect(bar).not.toContain('pl-12');
    expect(bar).toContain('<GlobalRulesControl');
  });
});

describe('CapabilityTabs route prefetch', () => {
  test('fully prefetches every capability page behind the loading boundary', () => {
    const body = code(source);
    const tabsStart = body.indexOf('export function CapabilityTabs');
    const tabs = body.slice(tabsStart);

    expect(tabs).toMatch(
      /<Link\s+href=\{capabilityTabHref\(projectId, tab\.key\)\}\s+prefetch=\{true\}>/,
    );
  });
});

/**
 * The tab bar is pinned by LAYOUT, not by `position`. Two classes carry that,
 * in two different files, and neither reads as load-bearing on its own — which
 * is exactly why they are pinned here.
 */
describe('CapabilityTabs stays pinned to the top', () => {
  const layout = code(
    readFileSync(
      fileURLToPath(
        new URL('../../../../app/(app)/projects/[id]/(capabilities)/layout.tsx', import.meta.url),
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
    expect(code(source)).toContain('relative flex shrink-0');
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

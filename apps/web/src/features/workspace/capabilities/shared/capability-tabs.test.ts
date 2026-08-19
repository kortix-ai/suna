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

  // The panel's own header carries collapse (ProjectSidebar) and the desktop
  // shell draws its own opener in the OS title-bar band, so this page-level
  // toggle exists only to bring a hidden panel back on the web. The rule is
  // pinned as a truth table in project-layout/sidebar-opener.test.ts — this
  // bar defers to it. It previously inlined `!isMobile && state === 'expanded'`,
  // which said nothing about the shell, so on macOS it drew a second opener
  // under the traffic lights.
  test('visibility comes from the shared gate, not a local rule', () => {
    expect(source).toContain('useShowPageSidebarOpener()');
    expect(code(source)).not.toContain('!sidebar.isMobile && sidebar.state ===');
  });

  // This bar is the first in-flow child of the capabilities layout, so on the
  // desktop shell its first tab starts at window x=0 — under the macOS traffic
  // lights. Hiding the toggle alone does not fix that; the row itself has to
  // indent.
  test('the row indents past the OS window controls on the desktop shell', () => {
    expect(source).toContain('kx-titlebar-row');
    expect(source).toContain("data-sidebar-collapsed={sidebar?.state === 'collapsed'");
  });

  // In-flow toggle: when it returns null the tabs just start earlier. Absolute
  // overlay + pl-12 clearance is what caused hit-target collisions before.
  test('the sidebar toggle sits in flow, not absolute over the tabs', () => {
    const body = code(source);
    const toggleStart = body.indexOf('function CapabilitySidebarToggle');
    const toggleEnd = body.indexOf('export function CapabilityTabs');
    const toggle = body.slice(toggleStart, toggleEnd);
    expect(toggle).not.toContain('absolute');
    expect(toggle).not.toContain('pl-12');
  });
});

/**
 * This bar navigates. It does not act.
 *
 * "Global rules" is connector approval policy — it has nothing to say on
 * Agents, Skills or Triggers, yet it rode above all four because the bar was
 * the only shared surface. It now lives in the Connectors page header, pinned
 * by `connectors/connectors-page.global-rules.test.ts`.
 */
describe('CapabilityTabs carries no capability-specific control', () => {
  test('Global rules is gone from the bar', () => {
    // Comment-stripped: the header comment above `CapabilityTabs` names the
    // control on purpose, to say where it went.
    const body = code(source);
    expect(body).not.toContain('GlobalRulesControl');
    expect(body).not.toContain('Global rules');
    expect(body).not.toContain('PoliciesPanel');
    expect(body).not.toContain("from '@/components/ui/sheet'");
  });

  test('the whole row stays in flow — no absolute overlay, no hit-area expand', () => {
    const body = code(source);
    expect(body).not.toContain('absolute');
    expect(body).not.toContain('before:-inset');
    expect(body).not.toContain('pr-12');
    expect(body).not.toContain('pl-12');
  });
});

/**
 * Settings reads as "how it's configured" — a different register from the
 * build-the-agent tabs (Connectors through Secrets) to its left. Jay's call
 * (2026-08-17): push it to the far right of the row, in one `TabsList` — not
 * a second list — so the underline indicator and keyboard roving stay
 * unified.
 */
describe('CapabilityTabs right-aligns Settings', () => {
  test('the trailing group is exactly Settings', () => {
    const body = code(source);
    const trailingStart = body.indexOf('TRAILING_TABS');
    expect(trailingStart).toBeGreaterThan(-1);
    const trailingDecl = body.slice(trailingStart, body.indexOf(';', trailingStart));
    expect(trailingDecl).toContain("'config'");
    expect(trailingDecl).not.toContain("'members'");
  });

  test('ml-auto lands on MembersLaunchLink, the first trailing element, inside the one shared TabsList', () => {
    const body = code(source);
    // Members isn't a CapabilityTab (it launches the account hub, not a
    // capability page) so it can't carry `tab.key === TRAILING_TABS[0]` — the
    // push instead lives on its own className.
    expect(body).toContain('ml-auto');
    expect(body).toContain('<MembersLaunchLink projectId={projectId} />');
    // One list, not two — this is a visual push, not a second `role="tablist"`.
    expect((body.match(/<TabsList\b/g) ?? []).length).toBe(1);
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

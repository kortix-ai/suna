import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';

import { Sidebar, SidebarEdgePeek, SidebarProvider, SidebarRail } from './sidebar';
import { SIDEBAR_MAX_WIDTH_PX, SIDEBAR_MIN_WIDTH_PX, SIDEBAR_WIDTH_PX } from './sidebar-width';

function renderShell(defaultOpen: boolean) {
  return renderToStaticMarkup(
    <SidebarProvider defaultOpen={defaultOpen}>
      <Sidebar collapsible="offcanvas" variant="inset">
        <span>content</span>
      </Sidebar>
      <SidebarEdgePeek />
    </SidebarProvider>,
  );
}

describe('SidebarEdgePeek', () => {
  test('renders the edge hover strip only while collapsed', () => {
    expect(renderShell(false)).toContain('sidebar-edge-peek');
    expect(renderShell(true)).not.toContain('sidebar-edge-peek');
  });

  test('keeps the edge hover strip above page headers', () => {
    expect(renderShell(false)).toContain('z-60');
  });
});

function renderRail(defaultOpen: boolean) {
  return renderToStaticMarkup(
    <SidebarProvider defaultOpen={defaultOpen}>
      <Sidebar collapsible="offcanvas" variant="inset">
        <SidebarRail />
      </Sidebar>
    </SidebarProvider>,
  );
}

const slotClass = (html: string, slot: string) =>
  html.match(new RegExp(`data-slot="${slot}"[^>]*class="([^"]*)"`))?.[1] ?? '';

describe('Sidebar offcanvas peek styling', () => {
  test('collapsed sidebar parks off-screen already in flyout geometry', () => {
    const html = renderShell(false);
    expect(html).toContain('data-collapsible="offcanvas"');
    expect(html).toContain('-translate-x-[calc(100%+2rem)]');
    expect(html).toContain('top-13');
    expect(html).not.toContain('data-peek');
  });

  test('expanded sidebar keeps full-height docked geometry', () => {
    const html = renderShell(true);
    expect(html).toContain('inset-y-0');
    expect(html).not.toContain('top-13');
  });

  test('the flyout radius is on the container too, so a consumer background cannot square off the corners', () => {
    // `className` lands on the CONTAINER, not on the rounded inner card. A
    // consumer that paints there (the project sidebar shipped `bg-sidebar`)
    // filled a square behind a round card, and it showed as four corner tabs
    // poking out past the arc. The container matching the radius clips it.
    const collapsed = renderToStaticMarkup(
      <SidebarProvider defaultOpen={false}>
        <Sidebar collapsible="offcanvas" variant="inset" className="bg-sidebar">
          <span>content</span>
        </Sidebar>
      </SidebarProvider>,
    );
    const cls = slotClass(collapsed, 'sidebar-container');
    expect(cls).toContain('bg-sidebar');
    expect(cls).toContain('rounded-lg');
    // Never `overflow-hidden` here — that would clip the card's own shadow.
    expect(cls).not.toContain('overflow-hidden');
  });

  test('the docked panel is square — the radius only exists in the flyout box', () => {
    expect(slotClass(renderShell(true), 'sidebar-container')).not.toContain('rounded');
  });

  test('the collapsed states ride the iOS sheet curve', () => {
    expect(slotClass(renderShell(false), 'sidebar-container')).toContain(
      'ease-[cubic-bezier(0.32,0.72,0,1)]',
    );
  });
});

/**
 * The rule this file exists to defend:
 *
 *   **Layout resolves in one frame; only `transform` is ever animated.**
 *
 * The content pane reclaims its 16rem in a single reflow at t=0, under the
 * panel, and the panel then slides off on the compositor to uncover it. The
 * corollary — geometry only ever changes while the panel is OFF-SCREEN — is
 * what the previous revision could not honour: it swapped docked geometry for
 * the flyout card at t=0, in full view, and that pop is why collapsing read as
 * instant even though a 220ms slide ran underneath it. Its fix was to delete
 * the animation entirely; this one keeps the animation and moves the swap.
 */
describe('Sidebar motion contract', () => {
  test('the one animated state animates transform, never a layout property', () => {
    const cls = slotClass(renderShell(false), 'sidebar-container');
    expect(cls).toContain('transition-transform');
    for (const layoutProp of ['left', 'right', 'top', 'bottom', 'width', 'height']) {
      expect(cls).not.toContain(`transition-[${layoutProp}`);
      expect(cls).not.toContain(`,${layoutProp}]`);
      expect(cls).not.toContain(`,${layoutProp},`);
    }
  });

  test('the content gap never animates its width', () => {
    for (const open of [true, false]) {
      expect(slotClass(renderShell(open), 'sidebar-gap')).not.toContain('transition');
    }
  });

  test('the panel card never animates its radius or shadow', () => {
    for (const open of [true, false]) {
      expect(slotClass(renderShell(open), 'sidebar-inner')).not.toContain('transition');
    }
  });

  test('opening declares no transition at all, from any trigger', () => {
    // A transition is read off the DESTINATION style. The docked branch
    // declaring none is what makes the panel, its contents, and the reflowed
    // content pane land on the same frame — no trailing content, nothing to
    // wait for after ⌘B.
    const cls = slotClass(renderShell(true), 'sidebar-container');
    expect(cls).toContain('translate-x-0');
    expect(cls).not.toContain('transition');
    expect(cls).not.toContain('duration-');
  });

  test('a keyboard-initiated collapse zeroes the slide', () => {
    const source = readFileSync(new URL('./sidebar.tsx', import.meta.url), 'utf8');
    // ⌘B sets the flag...
    expect(source).toContain('toggleSidebar({ instant: true })');
    // ...an Enter/Space click on a toggle button sets it via `detail === 0`...
    expect(source).toContain('options?.instant ?? options?.detail === 0');
    // ...and the flag wins the twMerge duration group.
    expect(source).toContain("instantToggle && 'duration-0'");
    // The undocking window is skipped too, so nothing is left mid-slide.
    expect(source).toContain("slides && state === 'collapsed' && !instantToggle");
  });

  test('the instant flag is released after a paint, not on a timeout', () => {
    // A `setTimeout(0)` can land before the paint and re-declare the
    // transition while the transform is still mid-change — animating the very
    // toggle that asked not to be animated.
    const source = readFileSync(new URL('./sidebar.tsx', import.meta.url), 'utf8');
    expect(source).toContain('second = requestAnimationFrame(() => setInstantToggle(false));');
  });

  test('the undock slide stays on the compositor and exits faster than it enters', () => {
    const cls = slotClass(renderShell(false), 'sidebar-container');
    expect(cls).toContain('-translate-x-[calc(100%+2rem)]');
    expect(cls).toContain('will-change-transform');
    expect(cls).toContain('motion-reduce:transition-none');
    // Parked is the resting collapsed state, reached by peek-out at 200ms.
    // The 240ms undock duration is asserted against SIDEBAR_UNDOCK_MS below.
    expect(cls).toContain('duration-[200ms]');
    expect(cls).toContain('ease-[cubic-bezier(0.32,0.72,0,1)]');
  });

  test('the undock timer outlasts the transform it covers', () => {
    const source = readFileSync(new URL('./sidebar.tsx', import.meta.url), 'utf8');
    const declared = source.match(/const SIDEBAR_UNDOCK_MS = (\d+);/)?.[1];
    expect(declared).toBe('240');
    // Same number, in the class the timer has to outlive. If one moves without
    // the other, the flyout card lands while the panel is still on screen.
    expect(source).toContain("undocking ? 'duration-[240ms]' : 'duration-[200ms]'");
  });

  test('the panel is stacked above content headers for the whole collapsed lifecycle', () => {
    expect(slotClass(renderShell(false), 'sidebar-container')).toContain('z-40');
  });

  test('the flyout card chrome is gated on the flyout box, not on being collapsed', () => {
    // `flyout` excludes the undocking window, so the exit slide keeps flush
    // docked chrome and no radius/shadow appears mid-flight.
    const source = readFileSync(new URL('./sidebar.tsx', import.meta.url), 'utf8');
    expect(source).toContain(
      "flyout && 'border-border overflow-hidden rounded-lg border shadow-xl'",
    );
  });

  test('the collapse phase is derived during render, never in an effect', () => {
    // An effect would commit one frame in flyout geometry first, and that
    // single frame IS the pop.
    const source = readFileSync(new URL('./sidebar.tsx', import.meta.url), 'utf8');
    expect(source).toContain('if (renderedState !== state) {');
  });
});

describe('SidebarRail', () => {
  test('is a resize separator, not a second collapse control', () => {
    const html = renderRail(true);
    expect(html).toContain('data-slot="sidebar-rail"');
    expect(html).toContain('role="separator"');
    expect(html).toContain('aria-orientation="vertical"');
    expect(html).toContain('aria-label="Resize sidebar"');
    expect(html).toContain('cursor-col-resize');
    // Reachable by keyboard: the WAI window-splitter pattern needs a focusable
    // separator for the arrow-key path to exist at all.
    expect(html).toContain('tabindex="0"');
  });

  test('publishes the live width and the allowed range to assistive tech', () => {
    const html = renderRail(true);
    expect(html).toContain(`aria-valuenow="${SIDEBAR_WIDTH_PX}"`);
    expect(html).toContain(`aria-valuemin="${SIDEBAR_MIN_WIDTH_PX}"`);
    expect(html).toContain(`aria-valuemax="${SIDEBAR_MAX_WIDTH_PX}"`);
  });

  test('renders nothing while collapsed — there is nothing to resize', () => {
    expect(renderRail(false)).not.toContain('data-slot="sidebar-rail"');
  });

  test('the hit area is 16px wide while the visible seam stays 2px', () => {
    const cls = slotClass(renderRail(true), 'sidebar-rail');
    expect(cls).toContain('w-4');
    expect(cls).toContain('after:w-[2px]');
  });
});

describe('SidebarProvider width', () => {
  test('renders the default width when no cookie has been written', () => {
    expect(renderShell(true)).toContain('--sidebar-width:16rem');
  });
});

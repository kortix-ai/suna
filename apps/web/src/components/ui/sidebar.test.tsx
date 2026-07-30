import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { Sidebar, SidebarEdgePeek, SidebarProvider } from './sidebar';

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

  test('collapsed container uses the drawer easing, expanded declares none', () => {
    expect(slotClass(renderShell(false), 'sidebar-container')).toContain(
      'ease-[cubic-bezier(0.32,0.72,0,1)]',
    );
    expect(slotClass(renderShell(true), 'sidebar-container')).not.toContain(
      'ease-[cubic-bezier(0.32,0.72,0,1)]',
    );
  });
});

/**
 * Docking the sidebar (collapsed → expanded) must land in a single frame. A
 * CSS transition is read off the DESTINATION style, so the docked branch is
 * only instant while it declares no transition at all — and the collapsed
 * branch is only cheap while its transition covers transform alone. Both are
 * load-bearing: the janky version this replaced glided the gap's `width` and
 * the container's `top`/`bottom`/`left`, reflowing the whole content subtree
 * every frame for 200ms.
 */
describe('Sidebar docking is instant', () => {
  test('docked container declares no transition, so every geometry change snaps', () => {
    expect(slotClass(renderShell(true), 'sidebar-container')).not.toContain('transition');
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

  test('the collapsed container animates transform only, never a layout property', () => {
    const cls = slotClass(renderShell(false), 'sidebar-container');
    expect(cls).toContain('transition-transform');
    // Guards the regression directly: no transition may name a property that
    // triggers layout.
    for (const layoutProp of ['left', 'right', 'top', 'bottom', 'width', 'height']) {
      expect(cls).not.toContain(`transition-[${layoutProp}`);
      expect(cls).not.toContain(`,${layoutProp}]`);
      expect(cls).not.toContain(`,${layoutProp},`);
    }
  });

  test('the undock slide stays on the compositor at 220ms', () => {
    const cls = slotClass(renderShell(false), 'sidebar-container');
    expect(cls).toContain('-translate-x-[calc(100%+2rem)]');
    expect(cls).toContain('duration-[220ms]');
    expect(cls).toContain('will-change-transform');
    expect(cls).toContain('motion-reduce:transition-none');
  });
});

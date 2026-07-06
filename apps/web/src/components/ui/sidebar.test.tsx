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
});

describe('Sidebar offcanvas peek styling', () => {
  test('collapsed sidebar parks off-screen already in flyout geometry', () => {
    const html = renderShell(false);
    expect(html).toContain('data-collapsible="offcanvas"');
    expect(html).toContain('-translate-x-[calc(100%+2rem)]');
    expect(html).toContain('top-13');
    expect(html).toContain('transition-[left,right,top,bottom,width,translate]');
    expect(html).not.toContain('data-peek');
  });

  test('expanded sidebar keeps full-height docked geometry', () => {
    const html = renderShell(true);
    expect(html).toContain('inset-y-0');
    expect(html).not.toContain('top-13');
  });

  test('collapsed container uses the drawer easing, expanded keeps linear docking', () => {
    const containerClass = (html: string) =>
      html.match(/data-slot="sidebar-container"[^>]*class="([^"]*)"/)?.[1] ?? '';
    expect(containerClass(renderShell(false))).toContain('ease-[cubic-bezier(0.32,0.72,0,1)]');
    expect(containerClass(renderShell(true))).not.toContain('ease-[cubic-bezier(0.32,0.72,0,1)]');
  });
});

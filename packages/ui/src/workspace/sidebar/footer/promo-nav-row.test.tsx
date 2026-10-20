import { describe, expect, mock, test } from 'bun:test';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// The sidebar primitives are layout slots; stub them as plain elements that
// keep their className so the badge's own classes can be read.
function slot(tag: string, marker: string) {
  function Slot({ className, children }: { className?: string; children?: ReactNode }) {
    return createElement(tag, { className, 'data-slot': marker }, children);
  }
  return Slot;
}
mock.module('../../../primitives/sidebar', () => ({
  SidebarMenuItem: slot('li', 'item'),
  SidebarMenuButton: slot('button', 'button'),
  SidebarMenuBadge: slot('div', 'badge'),
  SidebarMenuAction: slot('button', 'action'),
}));

const { PromoNavRow } = await import('./promo-nav-row');

// KRTX-2750: the "New" badge painted its label in kortix-blue over its own
// /15 tint — 2.65:1 in light theme, under the 4.5:1 a 13px label needs. The
// brand rule (color.md): a status chip keeps its label ink and paints the hue
// on the tint only, like the Badge `info` variant.
describe('PromoNavRow badge', () => {
  test('the label is ink on the blue /15 tint, never accent-colored text', () => {
    const html = renderToStaticMarkup(
      createElement(PromoNavRow, {
        icon: null,
        label: 'Connect MCP',
        badge: 'New',
        dismissLabel: 'Dismiss',
        onDismiss: () => {},
        onClick: () => {},
      }),
    );
    const badgeClass = html.match(/class="([^"]*)" data-slot="badge"/)?.[1] ?? '';
    const classes = badgeClass.split(/\s+/);
    expect(classes).toContain('bg-kortix-blue/15');
    expect(classes).toContain('text-foreground');
    expect(classes).not.toContain('text-kortix-blue');
  });
});

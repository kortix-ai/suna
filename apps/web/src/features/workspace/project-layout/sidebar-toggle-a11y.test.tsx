import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SidebarContext, type SidebarContextProps } from '@kortix/ui/sidebar-context';
import { SidebarToggle } from '@kortix/ui/workspace';

const base: SidebarContextProps = {
  state: 'expanded', open: true, isMobile: true, openMobile: false,
  setOpen: () => {}, setOpenMobile: () => {}, toggleSidebar: () => {},
  instantToggle: false, peek: false, peekEnter: () => {}, peekLeave: () => {},
  holdPeek: () => {}, width: 320, setWidth: () => {}, previewWidth: () => {},
};

function render(overrides: Partial<SidebarContextProps>) {
  return renderToStaticMarkup(
    <SidebarContext.Provider value={{ ...base, ...overrides }}>
      <SidebarToggle />
    </SidebarContext.Provider>,
  );
}

describe('sidebar toggle accessible state', () => {
  for (const state of ['expanded', 'collapsed'] as const) {
    test(`closed mobile sheet ignores ${state} desktop state`, () => {
      const html = render({ state });
      expect(html).toContain('aria-label="Open sidebar"');
      expect(html).toContain('aria-expanded="false"');
    });
    test(`open mobile sheet ignores ${state} desktop state`, () => {
      const html = render({ state, openMobile: true });
      expect(html).toContain('aria-label="Collapse sidebar"');
      expect(html).toContain('aria-expanded="true"');
    });
  }
  test('desktop hidden panel announces open', () => {
    const html = render({ isMobile: false, state: 'collapsed', open: false });
    expect(html).toContain('aria-label="Open sidebar"');
    expect(html).toContain('aria-expanded="false"');
  });
  test('desktop hover flyout announces pin and expanded', () => {
    const html = render({ isMobile: false, state: 'collapsed', open: false, peek: true });
    expect(html).toContain('aria-label="Pin sidebar"');
    expect(html).toContain('aria-expanded="true"');
  });
  test('the 26px ghost toggle carries a hit-area extension to the 44px floor (KRTX-2004)', () => {
    // The opener is a `size-7` ghost button (≈26px at the 0.23rem spacing
    // token) — far below the 44px mobile minimum. The box cannot grow in
    // every header row it renders into, so the tap target extends through
    // the shared hit-area pseudo-element (≈48px effective).
    const html = render({ isMobile: true });
    expect(html).toContain('hit-area-3');
  });
});

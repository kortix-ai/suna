import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SidebarContext, type SidebarContextProps } from '@/components/ui/sidebar-context';
import { SidebarToggle } from './sidebar-toggle';

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
});

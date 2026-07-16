import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SidebarProvider } from '@/components/ui/sidebar';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import { DetailLayer, DetailSidebarToggle } from './detail-view';

describe('DetailLayer a11y (W6)', () => {
  test('desktop detail is a labeled dialog', () => {
    const html = renderToStaticMarkup(
      <DetailLayer
        detail={{ key: 'k', title: 'Quarterly report', body: <div /> }}
        onBack={() => {}}
        isMobile={false}
      >
        <div>home</div>
      </DetailLayer>,
    );
    expect(html).toContain('role="dialog"');
    expect(html).not.toContain('aria-modal');
    expect(html).toContain('aria-label="Quarterly report"');
    expect(html).toContain('tabindex="-1"');
    // The focus target must never draw a focus ring — a keyboard-initiated
    // open (⌘K commands) makes the programmatic focus :focus-visible.
    expect(html).toContain('outline-none');
  });
});

describe('DetailSidebarToggle (F3v2)', () => {
  // The load-bearing case: EasyPanel also mounts on /debug/tools, which has
  // no SidebarProvider. `useSidebar` throws there — this must not, or it
  // takes down the whole panel. Forces `isExpanded: true` first (via the
  // live store, not the frozen SSR snapshot — see `useFullscreenSnapshot`'s
  // comment) so a future regression that reorders the gates can't
  // accidentally pass by riding the (also-false) fullscreen gate instead.
  test('renders null without a SidebarProvider', () => {
    useKortixComputerStore.setState({ isExpanded: true });
    try {
      expect(() => {
        const html = renderToStaticMarkup(<DetailSidebarToggle />);
        expect(html).toBe('');
      }).not.toThrow();
    } finally {
      useKortixComputerStore.setState({ isExpanded: false });
    }
  });

  test('with a provider, not fullscreen renders null', () => {
    useKortixComputerStore.setState({ isExpanded: false });
    const html = renderToStaticMarkup(
      <SidebarProvider>
        <DetailSidebarToggle />
      </SidebarProvider>,
    );
    expect(html).not.toContain('button');
  });

  test('with a provider, fullscreen + collapsed sidebar renders the toggle', () => {
    useKortixComputerStore.setState({ isExpanded: true });
    try {
      const html = renderToStaticMarkup(
        <SidebarProvider defaultOpen={false}>
          <DetailSidebarToggle />
        </SidebarProvider>,
      );
      expect(html).toContain('aria-label="Open sidebar"');
    } finally {
      useKortixComputerStore.setState({ isExpanded: false });
    }
  });

  test('with a provider, fullscreen + docked sidebar renders NOTHING — the sidebar carries its own collapse control', () => {
    useKortixComputerStore.setState({ isExpanded: true });
    try {
      const html = renderToStaticMarkup(
        <SidebarProvider defaultOpen>
          <DetailSidebarToggle />
        </SidebarProvider>,
      );
      // The provider renders its own wrapper div — the toggle contributes no
      // button and no label to it.
      expect(html).not.toContain('<button');
      expect(html).not.toContain('aria-label');
    } finally {
      useKortixComputerStore.setState({ isExpanded: false });
    }
  });
});

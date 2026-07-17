import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SidebarProvider } from '@/components/ui/sidebar';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import {
  CROSSFADE_TRANSITION,
  detailCardVariants,
  DetailLayer,
  DetailSidebarToggle,
  SLIDE_TRANSITION,
  terminalLayerMotion,
} from './detail-view';

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

  test('home is inert while the terminal layer covers it, not only while a detail does', () => {
    const covered = renderToStaticMarkup(
      <DetailLayer detail={null} onBack={() => {}} isMobile={false} terminalOpen>
        <div>home</div>
      </DetailLayer>,
    );
    expect(covered).toContain('aria-hidden="true"');
    expect(covered).toContain('inert');

    const idle = renderToStaticMarkup(
      <DetailLayer detail={null} onBack={() => {}} isMobile={false}>
        <div>home</div>
      </DetailLayer>,
    );
    expect(idle).not.toContain('aria-hidden="true"');
  });
});

describe('detail↔terminal choreography (pure motion contracts)', () => {
  // Both layers are OPAQUE cards, so a swap must never fade both at once —
  // the home would bleed through the midpoint. The terminal (painted above
  // by DOM order) owns the whole crossfade; the card appears/disappears at
  // full opacity underneath, timed to the terminal's fade.
  describe('detailCardVariants', () => {
    const v = detailCardVariants(false);

    test('arrival from home is the slide', () => {
      expect(v.hidden(false)).toEqual({ x: '100%', transition: SLIDE_TRANSITION });
      expect(v.visible(false)).toEqual({ x: 0, opacity: 1, transition: SLIDE_TRANSITION });
    });

    test('swap arrival lands instantly under the fading-out terminal', () => {
      expect(v.hidden(true)).toEqual({
        opacity: 0,
        transition: { duration: 0, delay: CROSSFADE_TRANSITION.duration },
      });
      expect(v.visible(true)).toEqual({ x: 0, opacity: 1, transition: { duration: 0 } });
    });

    test('swap exit holds fully opaque until the fading-in terminal covers it', () => {
      const exit = v.hidden(true);
      expect(exit.transition).toEqual({ duration: 0, delay: CROSSFADE_TRANSITION.duration });
    });

    test('reduced motion: no x movement anywhere, instant state changes', () => {
      const rv = detailCardVariants(true);
      expect(rv.hidden(false)).toEqual({ opacity: 0, transition: { duration: 0 } });
      expect(rv.hidden(true)).toEqual({ opacity: 0, transition: { duration: 0, delay: 0 } });
      expect(rv.visible(false)).toEqual({ x: 0, opacity: 1, transition: { duration: 0 } });
    });
  });

  describe('terminalLayerMotion', () => {
    test('home edges slide like a detail, opacity snapping only while off-panel', () => {
      const opened = terminalLayerMotion(true, false, false);
      expect(opened.target).toEqual({ x: 0, opacity: 1 });
      expect(opened.transition).toEqual({ ...SLIDE_TRANSITION, opacity: { duration: 0 } });

      const closed = terminalLayerMotion(false, false, false);
      expect(closed.target).toEqual({ x: '100%', opacity: 0 });
      expect(closed.transition).toEqual({
        ...SLIDE_TRANSITION,
        opacity: { duration: 0, delay: SLIDE_TRANSITION.duration },
      });
    });

    test('detail swaps crossfade, x teleporting only while invisible', () => {
      const over = terminalLayerMotion(true, true, false);
      expect(over.target).toEqual({ x: 0, opacity: 1 });
      expect(over.transition).toEqual({ ...CROSSFADE_TRANSITION, x: { duration: 0 } });

      const under = terminalLayerMotion(false, true, false);
      expect(under.transition).toEqual({
        ...CROSSFADE_TRANSITION,
        x: { duration: 0, delay: CROSSFADE_TRANSITION.duration },
      });
    });

    test('reduced motion is instant on every edge, slide or swap', () => {
      expect(terminalLayerMotion(true, false, true).transition).toEqual({
        duration: 0,
        x: { duration: 0 },
      });
      expect(terminalLayerMotion(false, true, true).transition).toEqual({
        duration: 0,
        x: { duration: 0, delay: 0 },
      });
    });
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

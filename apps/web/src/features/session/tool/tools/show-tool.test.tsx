import { TooltipProvider } from '@/components/ui/tooltip';
import type { ToolPart } from '@/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, mock, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  BoundActivateContext,
  ToolNavigationContext,
  ToolRunningContext,
  ToolSurfaceContext,
} from '@/features/session/tool/shared/infrastructure';
import { ShowTool } from './show-tool';

// Task 6: `isShowContentUnavailable`'s true verdict is driven by `contentStatus`
// (set via a `useEffect` inside `ShowContentRenderer`) and `preview.hasError`
// (set via a `useEffect`/timeout/iframe `onError` inside `useServicePreview`) —
// both only flip after mount. `renderToStaticMarkup` is a synchronous,
// effect-free render (see the header comment below), so neither state is
// reachable through the real component tree in this harness. Mocking the
// whole module — rather than importing the real export and wrapping it —
// mirrors `mode-gate.test.tsx`'s `useUserPreferencesStore` mock for the same
// reason: `mock.module` replaces the module for every import in this file, so
// a wrapper around the real export would recurse into the mock itself.
let forceShowContentUnavailable = false;

mock.module('@/features/session/show-availability', () => ({
  isShowContentUnavailable: () => forceShowContentUnavailable,
}));

// ShowTool calls `useTranslations('hardcodedUi')` unconditionally (for its
// loading-state copy), so it needs a NextIntlClientProvider ancestor even
// when the render path never reaches that branch — see mode-gate.test.tsx
// for the same requirement on AdvancedPanel. It also renders
// ShowContentRenderer, which calls `useFileContent` (react-query)
// unconditionally with `enabled: false` — still needs a QueryClientProvider
// ancestor even though no query actually fires under a static render.
function withProviders(node: ReactNode) {
  const queryClient = new QueryClient();
  return (
    <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>{node}</TooltipProvider>
      </QueryClientProvider>
    </NextIntlClientProvider>
  );
}

// show/show-user drives its INLINE (chat) surface with a scalloped panel
// shell: left tab = file name, right tab = toolbar, content always visible.
// The PANEL surface keeps its bespoke fill-the-pane rendering byte-for-byte —
// tool-part-renderer.tsx special-cases show/show-user as `fillsPanel` because
// the preview IS the payload there.

function makePart(input: Record<string, unknown>): ToolPart {
  return {
    type: 'tool',
    tool: 'show',
    callID: 'call-1',
    state: {
      status: 'completed',
      input,
      output: '',
      metadata: {},
    },
  } as unknown as ToolPart;
}

const PART = makePart({
  type: 'text',
  title: 'Quarterly Report Draft',
  content: 'Hello from the payload.',
});

describe('ShowTool drives its inline surface with a scalloped panel; panel stays visually identical', () => {
  test('inline surface renders the scalloped shell with the title tab and payload visible', () => {
    const html = renderToStaticMarkup(withProviders(<ShowTool part={PART} />));

    // Still tagged `tool-trigger` so activity-step.tsx's descendant size
    // overrides keep applying.
    expect(html).toContain('data-component="tool-trigger"');

    // Scalloped shell chrome: the tab and the content plane share one
    // `bg-secondary` fill, joined by the concave edge that makes the tab read
    // as raised out of the panel instead of stacked on top of it.
    expect(html).toContain('bg-secondary');
    expect(html).toContain('rounded-t-lg');
    expect(html).toContain('M0 0C0 32 16 64 38 64L0 64Z');

    // This fixture has no inline toolbar, so the content plane's top-right is
    // exposed and rounds itself; the left tab covers the top-left.
    expect(html).toContain('rounded-b-lg');
    expect(html).toContain('rounded-tr-lg');

    // Left tab label is the payload's resolved title (mirrors `showLabel`-style
    // precedence: title > description > basename/domain, never a raw path/URL).
    expect(html).toContain('Quarterly Report Draft');
    expect(html).toContain('aria-current="page"');

    // Always open: the payload lives in the content plane, not behind a disclosure.
    expect(html).toContain('Hello from the payload.');
    expect(html).not.toContain('aria-expanded');
  });

  test('content-only inline show exposes Preview when the panel activation is available', () => {
    const html = renderToStaticMarkup(
      withProviders(
        <BoundActivateContext.Provider value={() => {}}>
          <ShowTool part={PART} />
        </BoundActivateContext.Provider>,
      ),
    );

    expect(html).toContain('Preview</button>');
    // The Preview action adds the right toolbar tab.
    expect(html.match(/viewBox="0 0 38 64"/g)?.length).toBe(2);
    expect(html).not.toContain('rounded-tr-lg');
  });

  test('content-only inline show omits Preview when panel navigation is unavailable', () => {
    const html = renderToStaticMarkup(
      withProviders(
        <ToolNavigationContext.Provider value={false}>
          <BoundActivateContext.Provider value={() => {}}>
            <ShowTool part={PART} />
          </BoundActivateContext.Provider>
        </ToolNavigationContext.Provider>,
      ),
    );

    expect(html).not.toContain('Preview</button>');
    expect(html.match(/viewBox="0 0 38 64"/g)?.length).toBe(1);
  });

  test('panel surface omits content Preview because the artifact is already open', () => {
    const html = renderToStaticMarkup(
      withProviders(
        <ToolSurfaceContext.Provider value="panel">
          <BoundActivateContext.Provider value={() => {}}>
            <ShowTool part={PART} />
          </BoundActivateContext.Provider>
        </ToolSurfaceContext.Provider>,
      ),
    );

    expect(html).not.toContain('Preview</button>');
  });

  test('panel surface fills the pane exactly as before — no shell wrapper', () => {
    const html = renderToStaticMarkup(
      withProviders(
        <ToolSurfaceContext.Provider value="panel">
          <ShowTool part={PART} />
        </ToolSurfaceContext.Provider>,
      ),
    );

    // Fill markers captured from the pre-change panel markup: the outer card
    // switches to a flex column that fills the pane's height, and the content
    // wrapper drops its max-height cap in favor of `flex-1`.
    expect(html).toContain('flex h-full flex-col');
    expect(html).toContain('flex min-h-0 flex-1 flex-col');
    expect(html).toContain('min-h-0 flex-1 overflow-hidden');

    // No scallop shell on the panel surface — the preview still fills the
    // pane directly, unwrapped.
    expect(html).not.toContain('data-component="tool-trigger"');
    expect(html).not.toContain('aria-current="page"');

    expect(html).toContain('Hello from the payload.');
  });

  test('panel loading branch still renders the bespoke fill-the-pane loading card', () => {
    const runningPart = {
      type: 'tool',
      tool: 'show',
      callID: 'call-1',
      state: { status: 'running', input: {}, metadata: {} },
    } as unknown as ToolPart;

    const html = renderToStaticMarkup(
      withProviders(
        <ToolSurfaceContext.Provider value="panel">
          <ToolRunningContext.Provider value={true}>
            <ShowTool part={runningPart} />
          </ToolRunningContext.Provider>
        </ToolSurfaceContext.Provider>,
      ),
    );

    // Markers captured from the pre-change panel loading markup: a bg-card
    // container centered in the full pane height, with the Loading + shimmer
    // pair inside. (Carousel/website-preview branches are not exercised here:
    // their fixtures need a live carousel payload / proxied preview URL, which
    // a static render can't drive meaningfully.)
    expect(html).toContain('bg-card');
    expect(html).toContain('h-full');
    expect(html).toContain('items-center justify-center');
    expect(html).toContain('px-5 py-4');
  });

  test('inline loading relies on the shell header chrome — no duplicate loading card', () => {
    const runningPart = {
      type: 'tool',
      tool: 'show',
      callID: 'call-1',
      state: { status: 'running', input: {}, metadata: {} },
    } as unknown as ToolPart;

    const html = renderToStaticMarkup(
      withProviders(
        <ToolRunningContext.Provider value={true}>
          <ShowTool part={runningPart} />
        </ToolRunningContext.Provider>,
      ),
    );

    // The left scallop tab carries the running indicator itself, so the
    // bespoke panel loading card must not render a second one inline.
    expect(html).toContain('data-component="tool-trigger"');
    expect(html).toContain('animate-spinner-orbit');
    expect(html).not.toContain('bg-card');
    expect(html).not.toContain('px-5 py-4');
  });

  test('a title-less unsafe url never leaks into the left tab label', () => {
    const part = makePart({
      type: 'url',
      url: '/internal/session/abc?token=secret123',
    });

    const html = renderToStaticMarkup(withProviders(<ShowTool part={part} />));

    // showDomain() echoes unparseable input verbatim; the safeHttpUrl gate
    // must degrade a relative/non-http(s) url to the literal 'Link' instead
    // on the always-visible left tab — never the raw path or token.
    expect(html).toContain('title="Link"');
    expect(html).toMatch(/title="Link"[^>]*>Link</);
    // The tab's title attr is the safe label; a raw relative URL must not be
    // the tab's `title=` value (body content may still render the url string
    // via ShowContentRenderer — that is a separate surface).
    expect(html).not.toContain('title="/internal/session/abc?token=secret123"');
  });

  test('a show whose content failed to load still renders a fallback row (never disappears)', () => {
    forceShowContentUnavailable = true;
    try {
      const part = makePart({ type: 'file', path: '/workspace/report.pdf', title: 'Report' });
      const html = renderToStaticMarkup(withProviders(<ShowTool part={part} />));

      expect(html).toContain('Preview unavailable');
      // Pre-Task-6 behavior returned null here (empty markup) — this is the
      // exact regression this task fixes: a completed `show` never vanishes.
      expect(html).not.toBe('');

      // The shell still holds the tool's place in the transcript with the title.
      expect(html).toContain('data-component="tool-trigger"');
      expect(html).toContain('Report');
    } finally {
      forceShowContentUnavailable = false;
    }
  });

  test('file-backed inline show places toolbar actions in the right scallop tab', () => {
    const part = makePart({
      type: 'file',
      path: '/workspace/report.pdf',
      title: 'Report',
    });
    const html = renderToStaticMarkup(withProviders(<ShowTool part={part} />));

    // Left tab: title. Right tab: file actions (Refresh / Full screen / Open).
    expect(html).toContain('Report');
    expect(html).toContain('aria-label="Refresh"');
    // Two scallop SVGs — one on each tab edge.
    expect(html.match(/viewBox="0 0 38 64"/g)?.length).toBe(2);
  });
});

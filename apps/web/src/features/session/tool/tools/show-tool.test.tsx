import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, mock, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ToolPart } from '@/ui';

import {
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
      <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>
    </NextIntlClientProvider>
  );
}

// show/show-user drives its INLINE (chat) surface with `Disclosure`: a `w-fit`
// outline Button is the trigger, and the payload renders in
// `DisclosureContent`. The PANEL surface keeps its bespoke fill-the-pane
// rendering byte-for-byte — tool-part-renderer.tsx:122 special-cases
// show/show-user as `fillsPanel` because the preview IS the payload there.
//
// `renderToStaticMarkup` runs no effects, so `forceOpen` (a `useEffect`) can't
// open the disclosure in this harness — the open-state tests drive the
// synchronous `defaultOpen` prop instead.

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

describe('ShowTool drives its inline surface with Disclosure; panel stays visually identical', () => {
  test('inline surface renders a w-fit outline button as the disclosure trigger', () => {
    const html = renderToStaticMarkup(withProviders(<ShowTool part={PART} />));

    // Grammar: the trigger is a real <button>, still tagged `tool-trigger` so
    // activity-step.tsx's descendant size overrides keep applying.
    expect(html).toContain('data-component="tool-trigger"');
    expect(html).toContain('<button');
    expect(html).toContain('aria-expanded="false"');

    // Outline variant, hugging its content — not a full-bleed row.
    expect(html).toContain('border-border');
    expect(html).toContain('w-fit');

    // The label is the payload's resolved title (mirrors `showLabel`-style
    // precedence: title > description > basename/domain, never a raw path/URL).
    expect(html).toContain('Quarterly Report Draft');

    // Collapsed by default: the payload lives behind the trigger.
    expect(html).not.toContain('Hello from the payload.');
  });

  test('an open disclosure renders the payload in its content region', () => {
    const html = renderToStaticMarkup(withProviders(<ShowTool part={PART} defaultOpen />));

    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('Hello from the payload.');
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

    // No disclosure shell on the panel surface — the preview still fills the
    // pane directly, unwrapped.
    expect(html).not.toContain('data-component="tool-trigger"');

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

    // The trigger button carries the running indicator itself, so the bespoke
    // panel loading card must not render a second one inline.
    expect(html).toContain('data-component="tool-trigger"');
    expect(html).toContain('animate-spinner-orbit');
    expect(html).not.toContain('bg-card');
    expect(html).not.toContain('px-5 py-4');
  });

  test('a title-less unsafe url never leaks into the row subtitle', () => {
    const part = makePart({
      type: 'url',
      url: '/internal/session/abc?token=secret123',
    });

    // Collapsed, so the whole markup IS the trigger button.
    const html = renderToStaticMarkup(withProviders(<ShowTool part={part} />));

    // showDomain() echoes unparseable input verbatim; the safeHttpUrl gate
    // must degrade a relative/non-http(s) url to the literal 'Link' instead.
    expect(html).toContain('title="Link"');
    expect(html).not.toContain('token=secret123');
    expect(html).not.toContain('/internal/session/abc');
  });

  test('a show whose content failed to load still renders a fallback row (never disappears)', () => {
    forceShowContentUnavailable = true;
    try {
      const part = makePart({ type: 'file', path: '/workspace/report.pdf', title: 'Report' });
      const html = renderToStaticMarkup(withProviders(<ShowTool part={part} defaultOpen />));

      expect(html).toContain('Preview unavailable');
      // Pre-Task-6 behavior returned null here (empty markup) — this is the
      // exact regression this task fixes: a completed `show` never vanishes.
      expect(html).not.toBe('');

      // Collapsed, the trigger still holds the tool's place in the transcript.
      const collapsed = renderToStaticMarkup(withProviders(<ShowTool part={part} />));
      expect(collapsed).toContain('data-component="tool-trigger"');
      expect(collapsed).toContain('Report');
    } finally {
      forceShowContentUnavailable = false;
    }
  });
});

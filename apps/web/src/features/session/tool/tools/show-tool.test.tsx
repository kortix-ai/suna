import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ToolPart } from '@/ui';

import {
  ToolRunningContext,
  ToolSurfaceContext,
} from '@/features/session/tool/shared/infrastructure';
import { ShowTool } from './show-tool';

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

// Task 4: show/show-user joins the shared BasicTool shell on the INLINE
// (chat) surface only. The PANEL surface keeps its bespoke fill-the-pane
// rendering byte-for-byte — tool-part-renderer.tsx:122 special-cases
// show/show-user as `fillsPanel` because the preview IS the payload there.

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

describe('ShowTool joins the shared shell inline; panel stays visually identical', () => {
  test('inline surface renders the standard BasicTool row with the payload title as subtitle', () => {
    const html = renderToStaticMarkup(withProviders(<ShowTool part={PART} />));

    // Grammar: the collapsible row is BasicTool's inline trigger row.
    expect(html).toContain('data-component="tool-trigger"');

    // The row's own title is always "Show" — never the payload title itself,
    // which is reserved for the subtitle (mirrors `showLabel`-style
    // precedence: title > description > basename/domain, never a raw path/URL).
    expect(html).toContain('Show');
    expect(html).toContain('Quarterly Report Draft');

    // Expanded by default: the shown artifact is the payoff, so the body
    // (the rich preview) renders immediately, not behind a collapsed row.
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

    // No BasicTool shell on the panel surface — the preview still fills the
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

    // The BasicTool header already shows the standard running chrome, so the
    // bespoke loading card must not render a second indicator inline.
    expect(html).toContain('data-component="tool-trigger"');
    expect(html).not.toContain('bg-card');
    expect(html).not.toContain('items-center justify-center');
  });

  test('a title-less unsafe url never leaks into the row subtitle', () => {
    const part = makePart({
      type: 'url',
      url: '/internal/session/abc?token=secret123',
    });

    const html = renderToStaticMarkup(withProviders(<ShowTool part={part} />));

    // The trigger row is everything before the expanded body wrapper
    // (`mt-1 mb-1 overflow-hidden`, from CollapsibleToolRow).
    const [rowHtml] = html.split('mt-1 mb-1');

    // showDomain() echoes unparseable input verbatim; the safeHttpUrl gate
    // must degrade a relative/non-http(s) url to the literal 'Link' instead.
    expect(rowHtml).toContain('title="Link"');
    expect(rowHtml).not.toContain('token=secret123');
    expect(rowHtml).not.toContain('/internal/session/abc');
  });
});

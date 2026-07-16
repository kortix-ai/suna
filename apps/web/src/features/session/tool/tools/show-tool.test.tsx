import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ToolPart } from '@/ui';

import { ToolSurfaceContext } from '@/features/session/tool/shared/infrastructure';
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
});

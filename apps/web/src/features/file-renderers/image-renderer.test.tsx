import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, test } from 'bun:test';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TooltipProvider } from '@/components/ui/tooltip';
import { PreviewFitProvider } from '@/features/file-viewer/preview-fit';
import { ImageRenderer } from './image-renderer';

// ImageRenderer calls `useTranslations('hardcodedUi')` unconditionally for
// its toolbar labels (see show-tool.test.tsx for the same requirement), so
// it needs a NextIntlClientProvider ancestor even though this render never
// reaches an interactive state. Its floating toolbar also renders `Hint`
// (a Radix `Tooltip`), which needs a `TooltipProvider` ancestor.
function withIntl(node: ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
      <TooltipProvider>{node}</TooltipProvider>
    </NextIntlClientProvider>
  );
}

describe('ImageRenderer — inert outside a PreviewFitProvider (Global Constraint 2)', () => {
  // `usePreviewFit()`'s report only fires from the <img>'s `onLoad` handler.
  // `renderToStaticMarkup` performs a single, effect- and event-free render
  // pass (no DOM exists in this test runner — see test-setup.ts), so `onLoad`
  // never dispatches and the report call itself cannot be exercised here.
  // What IS verifiable statically: wiring `usePreviewFit()` into the
  // component must not change what gets rendered, with or without a
  // provider ancestor — the render-time half of "inert outside a
  // PreviewFitProvider".
  test('renders the image, byte-identically with or without a PreviewFitProvider ancestor', () => {
    const bare = renderToStaticMarkup(
      withIntl(<ImageRenderer url="https://example.com/photo.png" fileName="photo.png" />),
    );
    const wrapped = renderToStaticMarkup(
      withIntl(
        <PreviewFitProvider onMeasure={() => {}}>
          <ImageRenderer url="https://example.com/photo.png" fileName="photo.png" />
        </PreviewFitProvider>,
      ),
    );

    expect(bare).toContain('src="https://example.com/photo.png"');
    expect(wrapped).toBe(bare);
  });
});

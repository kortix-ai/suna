import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, test } from 'bun:test';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PreviewFitProvider } from '@/features/file-viewer/preview-fit';
import { VideoRenderer } from './video-renderer';

// VideoRenderer calls `useTranslations('hardcodedUi')` unconditionally for
// its error copy (see show-tool.test.tsx for the same requirement), so it
// needs a NextIntlClientProvider ancestor even though this render never
// reaches the error branch.
function withIntl(node: ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
      {node}
    </NextIntlClientProvider>
  );
}

describe('VideoRenderer — inert outside a PreviewFitProvider (Global Constraint 2)', () => {
  // `usePreviewFit()`'s report only fires from the <video>'s
  // `loadedmetadata` handler. `renderToStaticMarkup` performs a single,
  // effect- and event-free render pass (no DOM exists in this test runner —
  // see test-setup.ts), so `loadedmetadata` never dispatches and the report
  // call itself cannot be exercised here. What IS verifiable statically:
  // wiring `usePreviewFit()` into the component must not change what gets
  // rendered, with or without a provider ancestor — the render-time half of
  // "inert outside a PreviewFitProvider".
  test('renders the video, byte-identically with or without a PreviewFitProvider ancestor', () => {
    const bare = renderToStaticMarkup(
      withIntl(<VideoRenderer url="https://example.com/clip.mp4" />),
    );
    const wrapped = renderToStaticMarkup(
      withIntl(
        <PreviewFitProvider onMeasure={() => {}}>
          <VideoRenderer url="https://example.com/clip.mp4" />
        </PreviewFitProvider>,
      ),
    );

    expect(bare).toContain('src="https://example.com/clip.mp4"');
    expect(wrapped).toBe(bare);
  });
});

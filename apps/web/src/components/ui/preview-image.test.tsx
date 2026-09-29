/**
 * Characterization of the zoomable image-preview dialog, pinned through SSR
 * markup.
 *
 * `PreviewImageContent` renders everything inside `DialogPrimitive.Portal`,
 * and that portal gates on a `mounted` flag flipped by `useLayoutEffect`,
 * which never runs during static rendering — so the component renders as
 * nothing under `renderToStaticMarkup`, independent of `open` (the same
 * limitation `features/workspace/settings/settings-panel.test.tsx`
 * documents). The mock below passes the Radix dialog boundary through to the
 * static tree, so the component's own JSX — its structure, classes, zoom
 * state and accessibility labels — is asserted. Portal placement and the
 * open/close interaction stay covered by the Playwright journeys: `apps/web`
 * registers no DOM harness for `bun test`.
 */
import { describe, expect, mock, test } from 'bun:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('@radix-ui/react-dialog', () => ({
  Root: ({ children }: { children?: React.ReactNode }) => children,
  Trigger: ({ children }: { children?: React.ReactNode }) => children,
  Portal: ({ children }: { children?: React.ReactNode }) => children,
  Close: ({ children }: { children?: React.ReactNode }) => children,
  Overlay: React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
    function MockDialogOverlay(props, ref) {
      return <div ref={ref} {...props} />;
    },
  ),
  Content: React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
    function MockDialogContent(props, ref) {
      return <div ref={ref} {...props} />;
    },
  ),
  Title: React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
    function MockDialogTitle(props, ref) {
      return <h2 ref={ref} {...props} />;
    },
  ),
  Description: React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
    function MockDialogDescription(props, ref) {
      return <p ref={ref} {...props} />;
    },
  ),
}));

const { PreviewImageContent } = await import('./preview-image');

const renderPreview = (props: { fileContent: string; fileName?: string }) =>
  renderToStaticMarkup(<PreviewImageContent {...props} />);

describe('PreviewImageContent (the zoomable image dialog)', () => {
  const SRC = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';

  test('renders the file content as the image and the file name as its alt', () => {
    const html = renderPreview({ fileContent: SRC, fileName: 'run-chart.png' });
    expect(html).toContain('src="data:image/gif;base64,R0lGODlhAQABAAAAACw="');
    expect(html).toContain('alt="run-chart.png"');
  });

  test('falls back to the generic alt when the file has no name', () => {
    expect(renderPreview({ fileContent: SRC })).toContain('alt="Image preview"');
  });

  test('opens at the default zoom — scale(1), centred origin, zoom-in cursor', () => {
    const html = renderPreview({ fileContent: SRC });
    expect(html).toContain('transform:scale(1)');
    expect(html).toContain('transform-origin:50% 50%');
    expect(html).toContain('cursor-zoom-in');
  });

  test('carries the visually hidden dialog title and the close button', () => {
    const html = renderPreview({ fileContent: SRC });
    expect(html).toContain('Image preview');
    expect(html).toContain('aria-label="Close image preview"');
  });
});

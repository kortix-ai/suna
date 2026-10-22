/**
 * Characterization of `PreviewImageContent` — the zoomable image dialog.
 *
 * The dialog renders its body through a Radix portal, and a portal renders
 * nothing during SSR (its `mounted` state is set in a layout effect). The test
 * swaps the portal for a plain wrapper that renders the same children in the
 * same tree, so the dialog's real markup is observable in the static string.
 *
 * Pinned here are the pieces a dead-code sweep must not touch: the
 * visually-hidden dialog title, the close control, the zoom wrapper (its
 * resting `cursor-zoom-in` cursor and scale / transform-origin / transition
 * style) and the image itself.
 */
import { afterAll, describe, expect, mock, test } from 'bun:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('@radix-ui/react-portal', () => {
  const Portal = React.forwardRef(function PortalMock(
    props: { children?: React.ReactNode },
    ref: React.ForwardedRef<HTMLDivElement>,
  ) {
    return React.createElement('div', { ref }, props.children);
  });
  return { Portal, Root: Portal };
});

const { PreviewImage, PreviewImageContent } = await import('./preview-image');

afterAll(() => mock.restore());

const IMAGE_SRC = 'data:image/png;base64,AAAA';

const renderDialog = (fileContent: string | null = IMAGE_SRC, fileName = 'demo.png') =>
  renderToStaticMarkup(
    <PreviewImage open>
      <PreviewImageContent fileContent={fileContent ?? undefined} fileName={fileName} />
    </PreviewImage>,
  );

describe('PreviewImageContent — the zoomable image dialog', () => {
  test('renders the dialog with its hidden title and close control', () => {
    const html = renderDialog();

    expect(html).toContain('role="dialog"');
    expect(html).toContain('Image preview');
    expect(html).toContain('aria-label="Close image preview"');
  });

  test('renders the zoom wrapper at rest and the image', () => {
    const html = renderDialog();

    expect(html).toContain('cursor-zoom-in');
    expect(html).toContain('transform:scale(1)');
    expect(html).toContain('transform-origin:50% 50%');
    expect(html).toContain('transition:transform 200ms');
    expect(html).toContain('<img');
    expect(html).toContain('alt="demo.png"');
    expect(html).toContain(`src="${IMAGE_SRC}"`);
    expect(html).toContain('width="1920"');
    expect(html).toContain('height="1080"');
    expect(html).toContain('max-h-[100vh] w-auto object-contain');
  });

  test('renders the dialog but no image when there is no source', () => {
    const html = renderDialog(null);

    expect(html).toContain('role="dialog"');
    expect(html).not.toContain('<img');
  });

  test('keeps the exports the only call site imports', async () => {
    const mod = await import('./preview-image');

    for (const name of [
      'PreviewImage',
      'PreviewImageClose',
      'PreviewImageContent',
      'PreviewImageOverlay',
      'PreviewImagePortal',
      'PreviewImageTrigger',
    ]) {
      expect(name in mod).toBe(true);
    }
  });
});

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { NextIntlClientProvider } from '@/i18n/use-translations';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/** Every source `useBinaryBlob` was asked for, in order — which read a card
 *  chose is the behaviour under test for saved history. */
const blobReads: Array<string | null> = [];

// Image/video reach their render branch only once `useBinaryBlob` has a blob
// URL. The real hook is a react-query fetch against the sandbox, which never
// resolves under `renderToStaticMarkup` (one synchronous, effect-free pass), so
// the branch under test is unreachable without this stub. `mock.module`
// replaces the module for every import in this file — the same technique
// show-tool.test.tsx uses for `show-availability`.
mock.module('@/features/files/hooks/use-binary-blob', () => ({
  binaryBlobKeys: {
    all: ['runtime-files', 'binary-blob'],
    file: (serverUrl: string, filePath: string) => [
      'runtime-files',
      'binary-blob',
      serverUrl,
      filePath,
    ],
  },
  useBinaryBlob: (filePath: string | null) =>
    (blobReads.push(filePath), filePath)
      ? {
          blobUrl: 'blob:show-content-renderer-test',
          blob: new Blob(['x']),
          isLoading: false,
          error: null,
        }
      : { blobUrl: null, blob: null, isLoading: false, error: null },
}));

import { ShowContentRenderer, showBlobSource } from './show-content-renderer';

// ShowContentRenderer calls `useFileContent` (react-query) unconditionally, and
// its error copy goes through `useTranslations` — both providers are required
// even on a render path that reaches neither. Same requirement as
// show-tool.test.tsx.
function withProviders(node: ReactNode) {
  const queryClient = new QueryClient();
  return (
    <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
      <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>
    </NextIntlClientProvider>
  );
}

const HTML = '<h1>hello</h1>';

describe('ShowContentRenderer — the HTML preview blob URL is minted in an effect, not in render', () => {
  // The blob URL used to come out of a `useMemo` and be revoked by an effect
  // cleanup keyed on it. React StrictMode (on by default — next.config.ts does
  // not disable it) runs mount → cleanup → mount in one commit WITHOUT
  // re-rendering in between, so the cleanup revoked the very URL the next setup
  // left in place, and the iframe pointed at a dead blob for the rest of the
  // session. Creating the URL inside the effect is what makes the revoke safe:
  // a revoked URL is never the one the next render reads.
  //
  // `renderToStaticMarkup` performs a single, effect-free render pass (no DOM
  // in this runner — see test-setup.ts). That is exactly the discriminator:
  // under the old memo the URL was minted during that pass, under the effect it
  // is not.
  const realCreateObjectURL = URL.createObjectURL;
  let created: string[] = [];

  beforeEach(() => {
    created = [];
    URL.createObjectURL = ((blob: Blob) => {
      const url = realCreateObjectURL(blob);
      created.push(url);
      return url;
    }) as typeof URL.createObjectURL;
  });

  afterEach(() => {
    URL.createObjectURL = realCreateObjectURL;
    for (const url of created) URL.revokeObjectURL(url);
  });

  test('render alone never mints an object URL', () => {
    renderToStaticMarkup(
      withProviders(<ShowContentRenderer type="html" title="Preview" content={HTML} />),
    );

    expect(created).toEqual([]);
  });

  test('the pre-effect render commits no iframe rather than one pointing at a blob', () => {
    const html = renderToStaticMarkup(
      withProviders(<ShowContentRenderer type="html" title="Preview" content={HTML} />),
    );

    // No `src` can be correct before the effect has minted one, so the branch
    // holds the frame's box and renders the iframe only once it has a URL.
    // Falling through to the markdown fallback instead would flash the raw HTML
    // source at the user on every mount.
    expect(html).not.toContain('blob:');
    expect(html).not.toContain('<iframe');
    expect(html).toContain('data-component="html-preview"');
    expect(html).not.toContain('&lt;h1&gt;');
  });
});

// `ViewerFrame`'s header row, copied verbatim from viewer-frame.tsx. Matching
// the whole class string (not just `bg-secondary`, which several unrelated
// surfaces use) is what makes its presence/absence a real discriminator.
const VIEWER_FRAME_HEADER =
  'bg-secondary flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-2 border-b px-3 py-2';

describe('ShowContentRenderer — inline image/video are framed like every other viewer', () => {
  // Image and video returned a bare `<div>` on both surfaces while CSV, PPTX,
  // XLSX, DOCX, PDF and the plain-text viewer all went through `framed()`. The
  // inline card therefore had no file-name row above a picture, and the
  // `toolbarActions` slot `ViewerFrame` exists to carry had no host on those
  // two types.
  test('an inline image renders inside ViewerFrame, labelled with the file name', () => {
    const html = renderToStaticMarkup(
      withProviders(<ShowContentRenderer type="image" path="/workspace/photo.png" />),
    );

    expect(html).toContain(VIEWER_FRAME_HEADER);
    expect(html).toContain('photo.png');
  });

  test('an inline video renders inside ViewerFrame, labelled with the file name', () => {
    const html = renderToStaticMarkup(
      withProviders(<ShowContentRenderer type="video" path="/workspace/clip.mp4" />),
    );

    expect(html).toContain(VIEWER_FRAME_HEADER);
    expect(html).toContain('clip.mp4');
  });

  // `framed()` is a no-op under `fill`: on the panel surface the host already
  // draws the one header, so wrapping there would stack a second one.
  test('the panel surface leaves image and video unwrapped — it owns the header', () => {
    const image = renderToStaticMarkup(
      withProviders(<ShowContentRenderer type="image" path="/workspace/photo.png" fill />),
    );
    const video = renderToStaticMarkup(
      withProviders(<ShowContentRenderer type="video" path="/workspace/clip.mp4" fill />),
    );

    expect(image).not.toContain(VIEWER_FRAME_HEADER);
    expect(video).not.toContain(VIEWER_FRAME_HEADER);
  });
});


// ── Saved history: the stored copy of a shown file ─────────────────────────

const STORED =
  'kortix-attachment://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333';

describe('showBlobSource', () => {
  test('a stored copy wins over the sandbox path for every binary viewer', () => {
    for (const effectiveType of ['image', 'video', 'audio', 'docx', 'pptx']) {
      expect(
        showBlobSource({ effectiveType, attachment: STORED, sandboxPath: '/workspace/a.bin' }),
      ).toBe(STORED);
    }
  });

  test('with no stored copy the sandbox path is read, exactly as before', () => {
    expect(showBlobSource({ effectiveType: 'image', sandboxPath: '/workspace/a.png' })).toBe(
      '/workspace/a.png',
    );
    expect(
      showBlobSource({ effectiveType: 'image', attachment: '', sandboxPath: '/workspace/a.png' }),
    ).toBe('/workspace/a.png');
  });

  test('a PDF reads bytes only from a stored copy; its sandbox read stays base64', () => {
    expect(showBlobSource({ effectiveType: 'pdf', attachment: STORED, sandboxPath: '/w/r.pdf' })).toBe(
      STORED,
    );
    expect(showBlobSource({ effectiveType: 'pdf', sandboxPath: '/workspace/r.pdf' })).toBeNull();
  });

  test('HTML is NEVER read from a stored copy — it would run in the app origin', () => {
    for (const effectiveType of ['html', 'html-file']) {
      expect(
        showBlobSource({ effectiveType, attachment: STORED, sandboxPath: '/workspace/page.html' }),
      ).toBeNull();
    }
  });

  test('text viewers keep their own reads', () => {
    for (const effectiveType of ['markdown', 'code', 'text', 'csv', 'xlsx', 'mermaid']) {
      expect(
        showBlobSource({ effectiveType, attachment: STORED, sandboxPath: '/workspace/x' }),
      ).toBeNull();
    }
  });

  test('something that is not a stored reference is ignored, never fetched', () => {
    expect(
      showBlobSource({
        effectiveType: 'image',
        attachment: 'https://evil.test/x.png',
        sandboxPath: '/workspace/a.png',
      }),
    ).toBe('/workspace/a.png');
  });
});

describe('a card served from saved history', () => {
  test('an image with a stored copy asks for the copy, not the sandbox', () => {
    blobReads.length = 0;
    renderToStaticMarkup(
      withProviders(
        <ShowContentRenderer type="image" path="/workspace/out/revenue.png" attachment={STORED} />,
      ),
    );
    expect(blobReads).toContain(STORED);
    expect(blobReads).not.toContain('/workspace/out/revenue.png');
  });

  test('a live card (no stored copy) still reads the sandbox', () => {
    blobReads.length = 0;
    renderToStaticMarkup(
      withProviders(<ShowContentRenderer type="image" path="/workspace/out/revenue.png" />),
    );
    expect(blobReads).toContain('/workspace/out/revenue.png');
  });
});

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { HtmlPreview } from './html-preview';
import { HTML_PREVIEW_IFRAME_CLASS } from './html-preview';
import { SHARE_FILE_IFRAME_CLASS } from '@/app/(public)/share/session/[token]/share-layout';

// An HTML preview appears on three surfaces — the session panel, the files
// viewer, and a public share link. They must agree about what framing an HTML
// file looks like, and the one that is easiest to get wrong is the background.

describe('HTML_PREVIEW_IFRAME_CLASS', () => {
  test('paints white behind the document, like every other HTML frame', () => {
    // An iframe whose document sets no background is transparent, so the app's
    // surface shows through. In dark mode that renders an agent's black body
    // text on a near-black sheet — a page that looks blank. `bg-background`
    // is the exact mistake `SHARE_FILE_IFRAME_CLASS` documents guarding against.
    expect(HTML_PREVIEW_IFRAME_CLASS).toContain('bg-white');
    expect(HTML_PREVIEW_IFRAME_CLASS).not.toContain('bg-background');
    expect(SHARE_FILE_IFRAME_CLASS).toContain('bg-white');
  });

  test('fills its region edge to edge, with no frame border', () => {
    expect(HTML_PREVIEW_IFRAME_CLASS).toContain('h-full');
    expect(HTML_PREVIEW_IFRAME_CLASS).toContain('w-full');
    expect(HTML_PREVIEW_IFRAME_CLASS).toContain('border-0');
  });
});

// ── The files viewer's chrome, unchanged ───────────────────────────────────
// This component was extracted FROM the files viewer so the session panel
// could share it. An extraction that alters what the original surface looks
// like is not an extraction, it is a redesign nobody asked for. These pin the
// waiting state to the exact markup `file-content-renderer` shipped before it.

describe('HtmlPreview — waiting state', () => {
  // A static render never runs effects, so what it produces IS the pre-sandbox
  // waiting state — the one branch of this component a harness with no DOM can
  // reach, and the one both surfaces show first.
  const pending = renderToStaticMarkup(
    <HtmlPreview path="/workspace/index.html" fileName="index.html" />,
  );

  test('the spinner keeps its original size and dimming', () => {
    // `h-5 w-5 opacity-40`: a preview that has not started is a quiet wait, and
    // a full-strength spinner reads as an alert. (`size-4` also appears — it is
    // `Loading`'s own base class and is on every spinner in the app, so it says
    // nothing about this call site.)
    expect(pending).toContain('h-5 w-5 opacity-40');
  });

  test('the label keeps its original dimming, and the column its gap', () => {
    expect(pending).toContain('text-xs opacity-50');
    expect(pending).toContain('gap-3');
    expect(pending).not.toContain('gap-2');
  });

  test('it says what it is waiting for', () => {
    expect(pending).toContain('Starting preview server…');
  });
});

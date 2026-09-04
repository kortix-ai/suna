import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'bun:test';
import { TooltipProvider } from '@/components/ui/tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { getFileCategory } from '@/features/file-viewer';
import { isRich, reportsIntrinsicSize } from './file-preview';
import { FileViewer, isHtml, isMarkdown, isSvg, languageFor } from './file-viewer';

const SHARE_CONTEXT = { projectId: 'p1', sessionId: 's1' };

const FILE_VIEWER_SOURCE = readFileSync(new URL('./file-viewer.tsx', import.meta.url), 'utf8');

function Wrapped({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>{children}</TooltipProvider>
    </QueryClientProvider>
  );
}

// `ViewerActions` reads `usePublicShareLink`, which is a react-query hook — so
// even the no-share-context case needs a QueryClientProvider around it.
function render(fileName: string, content = 'x'): string {
  return renderToStaticMarkup(
    <Wrapped>
      <FileViewer content={content} fileName={fileName} path={`/workspace/${fileName}`} />
    </Wrapped>,
  );
}

function renderShareable(fileName: string, content = 'x'): string {
  return renderToStaticMarkup(
    <Wrapped>
      <FileViewer
        content={content}
        fileName={fileName}
        path={`/workspace/${fileName}`}
        shareContext={SHARE_CONTEXT}
      />
    </Wrapped>,
  );
}

describe('file kind predicates', () => {
  test('svg is recognised, and is not confused with the other rendered kind', () => {
    expect(isSvg('logo.svg')).toBe(true);
    expect(isSvg('LOGO.SVG')).toBe(true);
    expect(isSvg('chart.svg.bak')).toBe(false);
    expect(isSvg('page.html')).toBe(false);
    expect(isHtml('logo.svg')).toBe(false);
    expect(isMarkdown('logo.svg')).toBe(false);
  });

  test('svg highlights as xml — shiki has no svg grammar of its own', () => {
    expect(languageFor('logo.svg')).toBe('xml');
    expect(languageFor('page.html')).toBe('html');
    expect(languageFor('notes.txt')).toBe('text');
  });
});

describe('FilePreview routing', () => {
  test('svg leaves the rich path so its source text is fetched', () => {
    // The whole feature depends on this: on the rich path `FileContentRenderer`
    // only ever knows a URL, so the markup never reaches a component that could
    // show it.
    expect(isRich('logo.svg')).toBe(false);
    // Every other image stays rich — nothing else gained a source view.
    expect(isRich('photo.png')).toBe(true);
    expect(isRich('scan.jpeg')).toBe(true);
    expect(isRich('report.pdf')).toBe(true);
    // And the text path is unchanged.
    expect(isRich('page.html')).toBe(false);
    expect(isRich('notes.md')).toBe(false);
  });

  // ─── `reportsIntrinsicSize` decides whether opening a file HOLDS the panel's
  // current width (a ratio is coming) or clears it. It has to name exactly the
  // renderers that call `usePreviewFit().report()` — today PdfViewer,
  // ImageRenderer, VideoRenderer. Claiming one that never reports strands the
  // previous document's width on screen. ──
  test('claims exactly the categories whose renderer reports a size', () => {
    expect(reportsIntrinsicSize('report.pdf')).toBe(true);
    expect(reportsIntrinsicSize('photo.png')).toBe(true);
    expect(reportsIntrinsicSize('scan.jpeg')).toBe(true);
    expect(reportsIntrinsicSize('shot.webp')).toBe(true);
    expect(reportsIntrinsicSize('clip.mp4')).toBe(true);
    expect(reportsIntrinsicSize('clip.mov')).toBe(true);
  });

  test('excludes audio, which is rich but has no shape to report', () => {
    // It renders a transport bar. Holding a ratio for it would leave the last
    // document's width behind an audio player.
    expect(isRich('voice.mp3')).toBe(true);
    expect(reportsIntrinsicSize('voice.mp3')).toBe(false);
    expect(reportsIntrinsicSize('voice.wav')).toBe(false);
  });

  test('excludes svg, whose ImageRenderer sits outside the fit provider', () => {
    // Category `image`, but `isRich` sends it to FileViewer — where
    // `usePreviewFit()` is null and nothing is ever reported.
    expect(getFileCategory('logo.svg')).toBe('image');
    expect(reportsIntrinsicSize('logo.svg')).toBe(false);
  });

  test('excludes every rich format that renders a document, not a picture', () => {
    for (const name of ['deck.pptx', 'sheet.xlsx', 'data.csv', 'doc.docx', 'store.sqlite']) {
      expect(isRich(name)).toBe(true);
      expect(reportsIntrinsicSize(name)).toBe(false);
    }
  });

  test('excludes the text path entirely', () => {
    expect(reportsIntrinsicSize('notes.md')).toBe(false);
    expect(reportsIntrinsicSize('page.html')).toBe(false);
    expect(reportsIntrinsicSize('main.ts')).toBe(false);
    expect(reportsIntrinsicSize('notes.txt')).toBe(false);
  });
});

describe('FileViewer toolbar', () => {
  test('svg earns the Preview/Source toggle, exactly as html does', () => {
    const svg = render('logo.svg', '<svg xmlns="http://www.w3.org/2000/svg" />');
    expect(svg).toContain('aria-label="Preview"');
    expect(svg).toContain('aria-label="Source"');

    const html = render('page.html', '<p>hi</p>');
    expect(html).toContain('aria-label="Preview"');
    expect(html).toContain('aria-label="Source"');
  });

  test('a file with only one form gets no toggle — it would have one position', () => {
    // Markdown is the other no-toggle kind, but `DocMarkdown` can't be rendered
    // by this effect-free harness, so plain source stands in for both.
    const txt = render('notes.txt', 'hi');
    expect(txt).not.toContain('aria-label="Preview"');
    expect(isMarkdown('notes.md')).toBe(true);
  });

  test('svg gets the same actions as every other file', () => {
    // Routing SVG down the text path must not give it a toolbar of its own.
    // "Open in a new tab" is gone for every file now, and SVG had an extra
    // reason to never have it: it can carry <script>, and a top-level tab has
    // no sandbox attribute (`isBrowserViewable` excludes it on purpose).
    const svg = render('logo.svg', '<svg xmlns="http://www.w3.org/2000/svg" />');
    expect(svg).toContain('aria-label="Copy file contents"');
    expect(svg).not.toContain('aria-label="Open in a new tab"');
  });
});

// ── The split button ────────────────────────────────────────────────────────
// The toolbar used to be six flat icon peers. Everything that is a way of
// TAKING the output with you now lives in one labelled control plus a caret,
// and only full screen and close — which act on the panel, not the file — stay
// outside it. These lock the shape, because "one more little icon button" is
// exactly how the old row grew.

// ── An HTML file is SERVED, never injected ─────────────────────────────────
// The regression: the preview handed the file's text to the frame as `srcDoc`.
// A `srcDoc` document has no URL, so `./style.css`, `img/logo.png` and `app.js`
// had nothing to resolve against — every page arrived unstyled — and the frame
// carried `sandbox=""`, which made its scripts inert on top of that. The fix is
// to load the file from the static file server that ships inside the sandbox,
// which is what `HtmlPreview` does.

describe('FileViewer — HTML is served, not injected', () => {
  const PAGE = '<link rel="stylesheet" href="./style.css"><p>SENTINEL</p>';

  test('the file text never reaches the frame', () => {
    // The single assertion that fails the moment anyone reintroduces `srcDoc`:
    // the markup is data to be fetched by the frame, not markup to be embedded
    // in this document.
    const html = render('page.html', PAGE);
    expect(html).not.toContain('srcdoc');
    expect(html).not.toContain('SENTINEL');
    expect(html).not.toContain('style.css');
  });

  test('the preview waits on the sandbox rather than faking a render', () => {
    // No effects run in this harness, so what a static render shows IS the
    // pre-sandbox state: the wait, not a frame pointed at nothing.
    const html = render('page.html', PAGE);
    expect(html).toContain('Starting preview server…');
    expect(html).not.toContain('<iframe');
  });

  test('a script-inert frame is not the deal any more', () => {
    // `sandbox=""` withholds every capability, which turns any interactive page
    // into a screenshot. The preview now runs under
    // ISOLATED_HTML_PREVIEW_IFRAME_SANDBOX — scripts yes, same-origin no.
    expect(render('page.html', PAGE)).not.toContain('sandbox=""');
  });

  test('with no file on disk there is no rendered form, so no toggle', () => {
    // The preview is the file SERVED. Without a path there is nothing to serve,
    // and a Preview/Source toggle would have one honest position.
    const noPath = renderToStaticMarkup(
      <Wrapped>
        <FileViewer content={PAGE} fileName="page.html" />
      </Wrapped>,
    );
    expect(noPath).not.toContain('aria-label="Preview"');
    expect(noPath).not.toContain('Starting preview server…');
    // …and it falls through to source, where the markup is the document.
    expect(noPath).toContain('SENTINEL');
  });

  test('svg still renders inline — only HTML changed', () => {
    // SVG is loaded through <img> from a blob URL, a path this work did not
    // touch. Asserted so a future edit cannot quietly route it through the
    // static file server too.
    const svg = render('logo.svg', '<svg xmlns="http://www.w3.org/2000/svg" />');
    expect(svg).not.toContain('Starting preview server…');
  });
});

describe('FileViewer actions', () => {
  test('the primary action is a word, with no icon at all', () => {
    // Owner direction: an icon beside a label that already reads "Copy" is
    // decoration, and decoration is what made the old row unreadable. The
    // button's whole content is the word — asserted on the rendered element,
    // not on its neighbours, so a re-added <svg> fails this immediately.
    const md = renderShareable('notes.txt', 'hi');
    const open = md.indexOf('aria-label="Copy file contents"');
    expect(open).toBeGreaterThan(-1);
    const button = md.slice(md.lastIndexOf('<button', open), md.indexOf('</button>', open));
    expect(button).not.toContain('<svg');
    expect(button.endsWith('>Copy')).toBe(true);
  });

  test('Copy link and Download file are behind the caret, not beside it', () => {
    const md = renderShareable('notes.txt', 'hi');
    expect(md).toContain('aria-label="More actions"');
    // Radix renders menu content only once opened, so the items themselves
    // cannot appear in static markup — their absence here is the proof they
    // are not sitting in the toolbar row.
    expect(md).not.toContain('title="Copy public link"');
    expect(md).not.toContain('aria-label="Download"');
  });

  test('the removed icon peers stay removed', () => {
    // Two controls were deleted outright, not moved: "Ask for changes" (the
    // composer prefill) and, for files, "Open in a new tab".
    const md = renderShareable('notes.txt', 'hi');
    expect(md).not.toContain('aria-label="Ask for changes"');
    expect(md).not.toContain('aria-label="Open in a new tab"');
  });

  test('full screen and close stay outside the group — they act on the panel', () => {
    const md = renderShareable('notes.txt', 'hi');
    expect(md).toContain('aria-label="Full screen"');
  });

  test('a file with nothing but its text offers no caret at all', () => {
    // No path (nothing to download) and no share context (no link to mint), so
    // Copy is the only action. A menu holding zero items is a click for
    // nothing, so the group collapses to the lone button.
    const bare = renderToStaticMarkup(
      <Wrapped>
        <FileViewer content="hi" fileName="notes.txt" />
      </Wrapped>,
    );
    expect(bare).toContain('aria-label="Copy file contents"');
    expect(bare).not.toContain('aria-label="More actions"');
  });

  test('share context alone is not enough — a file with no path cannot be shared', () => {
    // `fileShareInput` returns null without a path, which is what withholds
    // Copy link. Download needs the path too, so nothing is left for a menu.
    const noPath = renderToStaticMarkup(
      <Wrapped>
        <FileViewer content="hi" fileName="notes.txt" shareContext={SHARE_CONTEXT} />
      </Wrapped>,
    );
    expect(noPath).not.toContain('aria-label="More actions"');
  });

  test('a path with no share context still earns the caret — Download lives there', () => {
    expect(render('notes.txt', 'hi')).toContain('aria-label="More actions"');
  });
});

// ── The two toolbars are one toolbar ───────────────────────────────────────
// `FileViewer` (text) and `PreviewShell` (everything else) are contractually
// required to render the same controls. The regression that contract exists
// for: `PreviewShell` rendered the share button and `FileViewer` did not, so
// every markdown and text output silently lost its public link. Routing both
// through `ViewerActions` is what makes that structural rather than a habit —
// so what is asserted is that neither file has grown its own copy again.

const PREVIEW_SOURCE = readFileSync(new URL('./file-preview.tsx', import.meta.url), 'utf8');

describe('shared toolbar contract', () => {
  test('both toolbars build their actions with ViewerActions', () => {
    expect(FILE_VIEWER_SOURCE).toContain('<ViewerActions');
    expect(PREVIEW_SOURCE).toContain('<ViewerActions');
  });

  test('neither hand-rolls a download, share or new-tab control of its own', () => {
    for (const source of [FILE_VIEWER_SOURCE, PREVIEW_SOURCE]) {
      expect(source).not.toContain('<DownloadButton');
      expect(source).not.toContain('<ShareFileButton');
      expect(source).not.toContain('<OpenInNewTabButton');
    }
  });

  test('both use the shared full-screen control rather than their own copy', () => {
    for (const source of [FILE_VIEWER_SOURCE, PREVIEW_SOURCE]) {
      expect(source).toContain('<PanelWidthButton');
      expect(source).not.toContain("aria-label={isExpanded ? 'Exit full screen' : 'Full screen'}");
    }
  });
});

// ── YAML frontmatter ────────────────────────────────────────────────────────
// The viewer handed the raw file to the markdown renderer, frontmatter and all.
// Markdown then read the block as prose: the opening `---` became a thematic
// break and the closing `---` turned everything above it into a setext <h2>.
// An agent definition therefore rendered as a stray horizontal rule followed by
// its entire metadata as one giant bold heading — while the SAME file in the
// chat's inline preview showed a tidy key/value card.

const AGENT_MD = `---
description: Veyris internal admin & build agent. Full access.
mode: primary
permission:
  "*": allow
---

You are **Veyris Internal**.
`;

describe('FileViewer — markdown frontmatter', () => {
  // Rendered assertions live in markdown-frontmatter.test.ts: `parseFrontmatter`
  // owns the behaviour and is tested directly there. DocMarkdown needs the full
  // i18n + sandbox-proxy provider stack, which this suite does not stand up (the
  // other cases here only render non-markdown paths), so what is asserted here
  // is the WIRING — that the viewer splits the file before the markdown parser
  // can see the fences.

  test('the markdown branch splits frontmatter off instead of passing raw content', () => {
    // The bug: `<DocMarkdown content={content} />`. Markdown then read `---` as
    // a thematic break and the closing `---` as a setext underline, turning the
    // whole metadata block into one giant <h2>.
    expect(FILE_VIEWER_SOURCE).toContain('parseFrontmatter');
    expect(FILE_VIEWER_SOURCE).not.toMatch(/<DocMarkdown\s+content=\{content\}/);
  });

  test('the parsed body — not the original file — reaches DocMarkdown', () => {
    expect(FILE_VIEWER_SOURCE).toMatch(/<DocMarkdown[\s\S]{0,120}content=\{body\}/);
  });

  test('the metadata renders through the shared card, not a bespoke one', () => {
    // Same component the chat's inline preview uses, so the two panes agree.
    expect(FILE_VIEWER_SOURCE).toContain('MarkdownFrontmatterCard');
  });
});

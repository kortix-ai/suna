import { describe, expect, test } from 'bun:test';
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

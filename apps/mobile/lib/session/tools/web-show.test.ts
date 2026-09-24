import { describe, expect, test } from 'bun:test';

import {
  showRowModel,
  getShowCarouselItemAriaLabel,
  getShowCarouselItemLabel,
  isShowBinaryPath,
  parseShowAspectRatio,
  parseShowItems,
  resolveShowPreviewUrl,
  resolveShowType,
  showBodyKind,
  showContentBranch,
  showDisplayTitle,
  showFileActions,
  showHeaderIconType,
  showInlineToolbarKind,
  showOpenTarget,
  showUnavailableLabel,
  shouldRenderFromSandboxFile,
} from './web-show';

// Port of apps/web `tool/tools/show-tool.test.tsx` over the decisions the
// component makes: the header label, the one toolbar, the body state, and
// the renderer branch. The markup assertions (class names, SVG paths) have no
// React Native equivalent; the decisions behind them do.

describe('show header label', () => {
  test('the payload title leads', () => {
    expect(
      showDisplayTitle({ isCarousel: false, itemCount: 0, title: 'Quarterly Report Draft', type: 'text', url: '' }),
    ).toBe('Quarterly Report Draft');
  });

  test('a title-less unsafe url never leaks into the header label', () => {
    expect(
      showDisplayTitle({
        isCarousel: false,
        itemCount: 0,
        title: '',
        type: 'url',
        url: '/internal/session/abc?token=secret123',
      }),
    ).toBe('Link');
  });

  test('a title-less safe url shows its domain', () => {
    expect(showDisplayTitle({ isCarousel: false, itemCount: 0, title: '', type: 'url', url: 'https://www.kortix.com/x' })).toBe(
      'kortix.com',
    );
  });

  test('error and generic output fallbacks', () => {
    expect(showDisplayTitle({ isCarousel: false, itemCount: 0, title: '', type: 'error', url: '' })).toBe('Error');
    expect(showDisplayTitle({ isCarousel: false, itemCount: 0, title: '', type: 'file', url: '' })).toBe('Output');
  });

  test('a carousel uses its title or "N items"', () => {
    expect(showDisplayTitle({ isCarousel: true, itemCount: 5, title: 'Deliverables', type: '', url: '' })).toBe(
      'Deliverables',
    );
    expect(showDisplayTitle({ isCarousel: true, itemCount: 2, title: '', type: '', url: '' })).toBe('2 items');
  });

  test('a carousel header shows ONE glyph: the active item type (no avatar group)', () => {
    expect(showHeaderIconType({ isCarousel: true, currentItemType: 'file', isWebsitePreview: false, type: '' })).toBe(
      'file',
    );
    expect(showHeaderIconType({ isCarousel: true, currentItemType: '', isWebsitePreview: false, type: '' })).toBe('image');
    expect(showHeaderIconType({ isCarousel: false, currentItemType: '', isWebsitePreview: true, type: 'file' })).toBe(
      'url',
    );
    expect(showHeaderIconType({ isCarousel: false, currentItemType: '', isWebsitePreview: false, type: 'file' })).toBe(
      'file',
    );
  });
});

describe('show inline toolbar', () => {
  const base = {
    isWebsitePreview: false,
    activePath: '',
    isCarousel: false,
    content: 'Hello from the payload.',
    canActivate: true,
    navigationEnabled: true,
  };

  test('content-only inline show exposes Preview when the panel activation is available', () => {
    expect(showInlineToolbarKind(base)).toBe('content-preview');
  });

  test('content-only inline show omits Preview when panel navigation is unavailable', () => {
    expect(showInlineToolbarKind({ ...base, navigationEnabled: false })).toBeNull();
    expect(showInlineToolbarKind({ ...base, canActivate: false })).toBeNull();
  });

  test('file-backed inline show places file actions in the header', () => {
    expect(showInlineToolbarKind({ ...base, activePath: '/workspace/report.pdf', content: '' })).toBe('file');
  });

  test('inline file actions are Refresh · Preview — one control per target, no duplicate open', () => {
    expect(showFileActions({ inPanel: false })).toEqual(['refresh', 'preview']);
  });

  test('panel file actions drop Preview and keep Full screen, as on web', () => {
    expect(showFileActions({ inPanel: true })).toEqual(['refresh', 'full-screen']);
  });

  test('a website preview gets the preview actions', () => {
    expect(showInlineToolbarKind({ ...base, isWebsitePreview: true, activePath: '/workspace/a.html' })).toBe('preview');
  });
});

describe('show body state', () => {
  test('a finished show with nothing to show draws nothing', () => {
    expect(showBodyKind({ running: false, type: '', hasItems: false, hasNothingToShow: true, unavailable: false })).toBe(
      'hidden',
    );
  });

  test('a running show with no input yet relies on the header spinner', () => {
    expect(showBodyKind({ running: true, type: '', hasItems: false, hasNothingToShow: true, unavailable: false })).toBe(
      'loading',
    );
  });

  test('a show whose content failed to load still renders a fallback row (never disappears)', () => {
    expect(
      showBodyKind({ running: false, type: 'file', hasItems: false, hasNothingToShow: false, unavailable: true }),
    ).toBe('unavailable');
    expect(showUnavailableLabel('Report')).toBe('Preview unavailable — Report');
    expect(showUnavailableLabel('')).toBe('Preview unavailable');
  });

  test('otherwise the payload renders', () => {
    expect(
      showBodyKind({ running: false, type: 'text', hasItems: false, hasNothingToShow: false, unavailable: false }),
    ).toBe('content');
  });
});

describe('show type resolution (web show-type-utils)', () => {
  test('a textish declaration is upgraded by a rich extension', () => {
    expect(resolveShowType('markdown', '/workspace/data.csv')).toBe('csv');
    expect(resolveShowType('file', '/workspace/report.pdf')).toBe('pdf');
    expect(resolveShowType('file', '/workspace/index.html')).toBe('html-file');
    expect(resolveShowType('text', '/workspace/clip.mov')).toBe('video');
  });

  test('explicit and non-rich declarations are kept', () => {
    expect(resolveShowType('image', '/workspace/a.csv')).toBe('image');
    expect(resolveShowType('file', '/workspace/a.py')).toBe('file');
    expect(resolveShowType('markdown', '')).toBe('markdown');
  });

  test('a path with no inline content renders from the sandbox file', () => {
    expect(shouldRenderFromSandboxFile('/workspace/a.yaml', '')).toBe(true);
    expect(shouldRenderFromSandboxFile('/workspace/a.yaml', 'x: 1')).toBe(false);
    expect(shouldRenderFromSandboxFile(null, '')).toBe(false);
  });

  test('aspect ratios parse to width / height', () => {
    expect(parseShowAspectRatio('16:9')).toBeCloseTo(16 / 9);
    expect(parseShowAspectRatio('auto')).toBeUndefined();
    expect(parseShowAspectRatio('')).toBeUndefined();
  });
});

describe('show renderer branch (web ShowContentRenderer cascade)', () => {
  const branch = (props: { type: string; path?: string; url?: string; content?: string }) =>
    showContentBranch({ path: '', url: '', content: '', ...props });

  test('localhost URLs and HTML files preview; a safe URL is a link card', () => {
    expect(branch({ type: 'url', url: 'http://localhost:3000/app' })).toBe('localhost');
    expect(branch({ type: 'file', path: '/workspace/site/index.html' })).toBe('html-file');
    expect(branch({ type: 'html', path: '/workspace/site/index.html' })).toBe('html-file');
    expect(branch({ type: 'url', url: 'https://kortix.com' })).toBe('url');
    expect(branch({ type: 'url', url: '/relative' })).toBe('url-unsafe');
  });

  test('media and documents', () => {
    expect(branch({ type: 'file', path: '/workspace/a.png' })).toBe('image');
    expect(branch({ type: 'image', url: 'https://i/a.png' })).toBe('image');
    expect(branch({ type: 'file', path: '/workspace/a.mp4' })).toBe('video');
    expect(branch({ type: 'file', path: '/workspace/a.mp3' })).toBe('audio');
    expect(branch({ type: 'file', path: '/workspace/a.pdf' })).toBe('pdf');
    expect(branch({ type: 'csv', content: 'a,b' })).toBe('csv');
    expect(branch({ type: 'file', path: '/workspace/a.xlsx' })).toBe('xlsx');
    expect(branch({ type: 'file', path: '/workspace/a.docx' })).toBe('docx');
    expect(branch({ type: 'file', path: '/workspace/a.pptx' })).toBe('pptx');
  });

  test('a path with no content renders from the file whatever its label', () => {
    expect(branch({ type: 'markdown', path: '/workspace/notes.md' })).toBe('sandbox-file');
    expect(branch({ type: 'code', path: '/workspace/a.yaml' })).toBe('sandbox-file');
  });

  test('inline content types', () => {
    expect(branch({ type: 'code', content: 'x = 1' })).toBe('code');
    expect(branch({ type: 'markdown', content: '# a' })).toBe('markdown');
    expect(branch({ type: 'text', content: 'hi' })).toBe('text');
    expect(branch({ type: 'html', content: '<p>x</p>' })).toBe('html');
    expect(branch({ type: 'error', content: 'boom' })).toBe('error');
    expect(branch({ type: 'weird', content: 'x' })).toBe('fallback');
  });
});

describe('show carousel', () => {
  test('items parse from an array or a JSON string; empty is null', () => {
    expect(parseShowItems([{ type: 'text', content: 'a' }])).toHaveLength(1);
    expect(parseShowItems(JSON.stringify([{ type: 'file', path: '/a' }]))).toHaveLength(1);
    expect(parseShowItems('[]')).toBeNull();
    expect(parseShowItems('{nope')).toBeNull();
    expect(parseShowItems(undefined)).toBeNull();
  });

  test('pill labels: port, document extension, title, domain, basename, type', () => {
    expect(getShowCarouselItemLabel({ type: 'url', url: 'http://localhost:5173/' })).toBe(':5173');
    expect(getShowCarouselItemLabel({ type: 'file', path: '/workspace/report.pdf', title: 'Report' })).toBe('PDF');
    expect(getShowCarouselItemLabel({ type: 'docx' })).toBe('DOCX');
    expect(getShowCarouselItemLabel({ type: 'text', title: 'A very long deliverable title' })).toBe('A very long deliv…');
    expect(getShowCarouselItemLabel({ type: 'url', url: 'https://www.kortix.com/a' })).toBe('kortix.com');
    expect(getShowCarouselItemLabel({ type: 'file', path: '/workspace/notes.md' })).toBe('notes.md');
    expect(getShowCarouselItemLabel({ type: 'markdown', content: 'x' })).toBe('Markdown');
    expect(getShowCarouselItemLabel({ type: '' })).toBe('Item');
  });

  test('the accessibility label names the position, title or label, and type', () => {
    expect(getShowCarouselItemAriaLabel({ type: 'file', title: 'Report' }, 0, 3, 'PDF')).toBe(
      'Item 1 of 3 · Report · file',
    );
    expect(getShowCarouselItemAriaLabel({ type: 'text' }, 1, 3, 'Text')).toBe('Item 2 of 3 · Text · text');
  });
});

describe('show preview target', () => {
  test('a localhost URL previews as itself; an HTML file through the static server', () => {
    expect(resolveShowPreviewUrl({ activeUrl: 'http://localhost:3000', activePath: '', activeType: 'url' })).toBe(
      'http://localhost:3000',
    );
    const html = resolveShowPreviewUrl({ activeUrl: '', activePath: '/workspace/a.html', activeType: 'file' });
    expect(html).toContain('localhost');
    expect(html).toContain('a.html');
    expect(resolveShowPreviewUrl({ activeUrl: '', activePath: '/workspace/a.html', activeType: 'code' })).toBe('');
    expect(resolveShowPreviewUrl({ activeUrl: 'https://kortix.com', activePath: '', activeType: 'url' })).toBe('');
  });
});

describe('show open target (useShowOpenInTab)', () => {
  test('an HTML file opens its static-server preview', () => {
    const target = showOpenTarget({ type: 'file', url: '', path: '/workspace/site/index.html' });
    expect(target?.kind).toBe('html-file');
    expect(target && 'staticUrl' in target ? target.staticUrl : '').toContain('index.html');
  });

  test('a localhost URL opens the sandbox preview, never the external browser', () => {
    expect(showOpenTarget({ type: 'url', url: 'http://localhost:5173/app', path: '' })).toEqual({ kind: 'localhost' });
  });

  test('a safe http(s) URL opens externally, normalised like web safeHttpUrl', () => {
    expect(showOpenTarget({ type: 'url', url: ' https://kortix.com ', path: '' })).toEqual({
      kind: 'external',
      url: 'https://kortix.com/',
    });
  });

  test('an unsafe or malformed URL never opens externally', () => {
    expect(showOpenTarget({ type: 'url', url: 'https://', path: '' })).toBeNull();
    expect(showOpenTarget({ type: 'url', url: 'javascript:alert(1)', path: '' })).toBeNull();
    expect(showOpenTarget({ type: 'url', url: '/internal/x', path: '/workspace/a.pdf' })).toEqual({
      kind: 'file',
      path: '/workspace/a.pdf',
    });
  });

  test('a non-HTML path opens the file viewer; nothing at all opens nothing', () => {
    expect(showOpenTarget({ type: 'file', url: '', path: '/workspace/a.pdf' })).toEqual({
      kind: 'file',
      path: '/workspace/a.pdf',
    });
    expect(showOpenTarget({ type: 'html', url: '', path: '/workspace/a.htm.bak' })).toEqual({
      kind: 'file',
      path: '/workspace/a.htm.bak',
    });
    expect(showOpenTarget({ type: 'text', url: '', path: '' })).toBeNull();
  });
});

describe('show sandbox file text read', () => {
  test('binary files are never read as text; text and code files are', () => {
    expect(isShowBinaryPath('/workspace/build.zip')).toBe(true);
    expect(isShowBinaryPath('/workspace/font.woff2')).toBe(true);
    expect(isShowBinaryPath('/workspace/app.sqlite')).toBe(true);
    expect(isShowBinaryPath('/workspace/config.yaml')).toBe(false);
    expect(isShowBinaryPath('/workspace/notes.md')).toBe(false);
    expect(isShowBinaryPath('/workspace/Makefile')).toBe(false);
  });
});

describe('showRowModel — the transcript row (option B)', () => {
  test('a file names itself and its kind, and only an image carries a still', () => {
    expect(showRowModel({ type: 'html', path: '/workspace/hello.html', url: '', title: 'Hello' })).toEqual({
      title: 'hello.html',
      subtitle: 'Page',
      thumb: 'glyph',
    });
    expect(showRowModel({ type: 'file', path: '/workspace/revenue.png', url: '', title: '' })).toEqual({
      title: 'revenue.png',
      subtitle: 'Image',
      thumb: 'image',
    });
    expect(showRowModel({ type: 'file', path: '/workspace/q3.pdf', url: '', title: 'Quarter' })).toEqual({
      title: 'q3.pdf',
      subtitle: 'PDF',
      thumb: 'glyph',
    });
  });

  test('a link reads as its domain; a direct image URL still gets its still', () => {
    expect(showRowModel({ type: 'link', path: '', url: 'https://kortix.ai/pricing', title: '' })).toEqual({
      title: 'kortix.ai',
      subtitle: 'kortix.ai',
      thumb: 'glyph',
    });
    expect(showRowModel({ type: 'link', path: '', url: 'https://cdn.test/a/chart.png', title: 'Chart' })).toEqual({
      title: 'Chart',
      subtitle: 'cdn.test',
      thumb: 'image',
    });
  });

  test('with neither a path nor a URL it falls back to the title, then the kind', () => {
    expect(showRowModel({ type: 'markdown', path: '', url: '', title: 'Launch notes' }).title).toBe('Launch notes');
    expect(showRowModel({ type: 'markdown', path: '', url: '', title: '' })).toEqual({
      title: 'Markdown',
      subtitle: 'Markdown',
      thumb: 'glyph',
    });
  });
});

describe('showRowModel — a running app', () => {
  test('a localhost URL reads as a preview and its port, never the proxy URL', () => {
    expect(showRowModel({ type: 'website', path: '', url: 'http://localhost:3000', title: '' })).toEqual({
      title: 'App preview',
      subtitle: 'localhost:3000',
      thumb: 'glyph',
    });
    expect(showRowModel({ type: 'website', path: '', url: 'http://localhost:5173/dashboard', title: 'Dashboard' })).toEqual({
      title: 'Dashboard',
      subtitle: 'localhost:5173/dashboard',
      thumb: 'glyph',
    });
  });
});

describe('showRowModel — SVG never previews in the row', () => {
  test('an SVG keeps its glyph; a PNG beside it still shows its still', () => {
    expect(showRowModel({ type: 'image', path: '/workspace/logo.svg', url: '', title: '' })).toEqual({
      title: 'logo.svg',
      subtitle: 'Image',
      thumb: 'glyph',
    });
    expect(showRowModel({ type: 'image', path: '/workspace/logo.png', url: '', title: '' }).thumb).toBe('image');
    expect(showRowModel({ type: 'link', path: '', url: 'https://cdn.test/logo.svg', title: '' }).thumb).toBe('glyph');
  });
});

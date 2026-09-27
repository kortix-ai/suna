import { describe, expect, test } from 'bun:test';

import {
  HTML_SANITIZER_SCRIPT,
  allowBrowserNavigation,
  decidePreviewNavigation,
  escapeForInlineScript,
} from './html-embed';

describe('escapeForInlineScript', () => {
  const payload = 'const a = 1;</script><script>alert(1)</script><!-- x';

  test('leaves no closing script tag or comment opener in the output', () => {
    const out = escapeForInlineScript(JSON.stringify(payload));
    expect(out.toLowerCase()).not.toContain('</script');
    expect(out).not.toContain('<!--');
    expect(out).not.toContain('<');
  });

  test('still evaluates to the original string', () => {
    const out = escapeForInlineScript(JSON.stringify(payload));
    expect(new Function(`return ${out};`)()).toBe(payload);
  });

  test('escapes U+2028 and U+2029 line separators', () => {
    const value = 'a\u2028b\u2029c';
    const out = escapeForInlineScript(JSON.stringify(value));
    expect(out).not.toContain('\u2028');
    expect(out).not.toContain('\u2029');
    expect(new Function(`return ${out};`)()).toBe(value);
  });
});

describe('decidePreviewNavigation', () => {
  test('allows the inline document loads', () => {
    expect(decidePreviewNavigation('about:blank')).toBe('allow');
    expect(decidePreviewNavigation('about:srcdoc')).toBe('allow');
    expect(decidePreviewNavigation('data:text/html;base64,AAAA')).toBe('allow');
    expect(decidePreviewNavigation('blob:https://cdnjs.cloudflare.com/1234')).toBe('allow');
  });

  test('allows in-page fragment navigation on the inline document', () => {
    expect(decidePreviewNavigation('about:blank#_Toc1')).toBe('allow');
    expect(decidePreviewNavigation('about:srcdoc#section')).toBe('allow');
    expect(decidePreviewNavigation('about:blankx')).toBe('block');
    expect(decidePreviewNavigation('about:config#x')).toBe('block');
  });

  test('opens outside the app only for a user click when a click is required', () => {
    const allowedOrigin = 'https://api.kortix.com';
    const external = 'https://other.example/page';
    // iOS link tap
    expect(
      decidePreviewNavigation(external, { allowedOrigin, externalRequiresClick: true, navigationType: 'click' }),
    ).toBe('open-external');
    // iOS script redirect or form submit
    expect(
      decidePreviewNavigation(external, { allowedOrigin, externalRequiresClick: true, navigationType: 'other' }),
    ).toBe('block');
    expect(
      decidePreviewNavigation(external, { allowedOrigin, externalRequiresClick: true, navigationType: 'formsubmit' }),
    ).toBe('block');
    // Android: no click information
    expect(decidePreviewNavigation(external, { allowedOrigin, externalRequiresClick: true })).toBe('block');
    expect(decidePreviewNavigation('mailto:a@b.c', { externalRequiresClick: true })).toBe('block');
    // Same-origin pages still load in the WebView
    expect(
      decidePreviewNavigation('https://api.kortix.com/v1/p/x/8000/b.html', {
        allowedOrigin,
        externalRequiresClick: true,
      }),
    ).toBe('allow');
  });

  test('allows file URLs only when the caller opts in', () => {
    expect(decidePreviewNavigation('file:///tmp/a.pdf')).toBe('block');
    expect(decidePreviewNavigation('file:///tmp/a.pdf', { allowFileUrls: true })).toBe('allow');
  });

  test('opens top-frame web and mail links outside the app', () => {
    expect(decidePreviewNavigation('https://evil.example/login')).toBe('open-external');
    expect(decidePreviewNavigation('HTTP://evil.example')).toBe('open-external');
    expect(decidePreviewNavigation('mailto:a@b.c')).toBe('open-external');
  });

  test('blocks sub-frame web loads in inline previews', () => {
    expect(decidePreviewNavigation('https://evil.example', { isTopFrame: false })).toBe('block');
  });

  test('blocks every other scheme', () => {
    expect(decidePreviewNavigation('javascript:alert(1)')).toBe('block');
    expect(decidePreviewNavigation(' javascript:alert(1)')).toBe('block');
    expect(decidePreviewNavigation('intent://scan/#Intent;scheme=zxing;end')).toBe('block');
    expect(decidePreviewNavigation('kortix://auth/callback')).toBe('block');
    expect(decidePreviewNavigation('tel:123')).toBe('block');
    expect(decidePreviewNavigation('')).toBe('block');
  });

  test('keeps same-origin navigation in an allowed-origin preview', () => {
    const allowedOrigin = 'https://api.kortix.com';
    expect(
      decidePreviewNavigation('https://api.kortix.com/v1/p/abc/8000/index.html', { allowedOrigin }),
    ).toBe('allow');
    expect(decidePreviewNavigation('HTTPS://API.KORTIX.COM/other', { allowedOrigin })).toBe('allow');
    expect(decidePreviewNavigation('https://api.kortix.com.evil.example/', { allowedOrigin })).toBe(
      'open-external',
    );
    expect(
      decidePreviewNavigation('https://cdn.example/embed', { allowedOrigin, isTopFrame: false }),
    ).toBe('allow');
  });
});

describe('decidePreviewNavigation in browser mode', () => {
  const browser = { mode: 'browser' as const };

  test('loads every http and https page inside the WebView, in any frame', () => {
    expect(decidePreviewNavigation('https://example.com/page', browser)).toBe('allow');
    expect(decidePreviewNavigation('HTTP://localhost:3000/', browser)).toBe('allow');
    expect(decidePreviewNavigation('https://cdn.example/embed', { ...browser, isTopFrame: false })).toBe('allow');
    expect(
      decidePreviewNavigation('https://other.example', { ...browser, navigationType: 'other' }),
    ).toBe('allow');
  });

  test('allows about:blank, data:, and blob: inside the WebView', () => {
    expect(decidePreviewNavigation('about:blank', browser)).toBe('allow');
    expect(decidePreviewNavigation('data:text/html,<p>x</p>', browser)).toBe('allow');
    expect(decidePreviewNavigation('blob:https://example.com/1234', browser)).toBe('allow');
  });

  test('blocks every other scheme and never opens it outside the app', () => {
    const urls = [
      'intent://scan/#Intent;scheme=zxing;end',
      'market://details?id=x',
      'tel:123',
      'sms:123',
      'mailto:a@b.c',
      'kortix://auth/callback?code=x',
      'javascript:alert(1)',
      'file:///etc/hosts',
      'about:config',
      '',
    ];
    for (const url of urls) {
      expect(decidePreviewNavigation(url, { ...browser, navigationType: 'click' })).toBe('block');
    }
  });
});

describe('allowBrowserNavigation', () => {
  test('is the WebView request guard for browser mode', () => {
    expect(allowBrowserNavigation({ url: 'https://example.com/' })).toBe(true);
    expect(allowBrowserNavigation({ url: 'about:blank' })).toBe(true);
    expect(allowBrowserNavigation({ url: 'intent://x#Intent;end' })).toBe(false);
    expect(allowBrowserNavigation({ url: 'kortix://auth/callback' })).toBe(false);
  });
});

// Minimal DOM stand-in with the surface the sanitizer script uses:
// querySelectorAll('*'), tagName, attributes, removeAttribute, parentNode.removeChild.
interface FakeAttr {
  name: string;
  value: string;
}
class FakeElement {
  parentNode: FakeElement | null = null;
  children: FakeElement[] = [];
  attributes: FakeAttr[];
  constructor(
    public tagName: string,
    attrs: Record<string, string> = {},
    children: FakeElement[] = [],
  ) {
    this.attributes = Object.entries(attrs).map(([name, value]) => ({ name, value }));
    for (const child of children) {
      child.parentNode = this;
      this.children.push(child);
    }
  }
  removeAttribute(name: string) {
    this.attributes = this.attributes.filter((a) => a.name !== name);
  }
  removeChild(child: FakeElement) {
    this.children = this.children.filter((c) => c !== child);
    child.parentNode = null;
  }
  querySelectorAll(selector: string): FakeElement[] {
    if (selector !== '*') throw new Error(`unsupported selector ${selector}`);
    const out: FakeElement[] = [];
    const walk = (el: FakeElement) => {
      for (const child of el.children) {
        out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  attr(name: string) {
    return this.attributes.find((a) => a.name === name)?.value;
  }
}

const sanitize = new Function(`${HTML_SANITIZER_SCRIPT}\nreturn sanitizeUntrustedHtml;`)() as (
  root: FakeElement,
) => void;

describe('HTML_SANITIZER_SCRIPT', () => {
  test('contains no closing script tag, backtick, or template interpolation', () => {
    expect(HTML_SANITIZER_SCRIPT.toLowerCase()).not.toContain('</script');
    expect(HTML_SANITIZER_SCRIPT).not.toContain('`');
    expect(HTML_SANITIZER_SCRIPT).not.toContain('${');
  });

  test('removes active and embedding elements', () => {
    const tags = ['script', 'iframe', 'object', 'embed', 'SCRIPT', 'style', 'svg', 'form', 'meta', 'base', 'link'];
    const root = new FakeElement('body', {}, [
      new FakeElement('p', {}, tags.map((t) => new FakeElement(t))),
    ]);
    sanitize(root);
    expect(root.querySelectorAll('*').map((e) => e.tagName)).toEqual(['p']);
  });

  test('strips every on* handler and style attribute', () => {
    const img = new FakeElement('img', {
      src: 'data:image/png;base64,AAAA',
      onerror: 'alert(1)',
      ONLOAD: 'alert(2)',
      style: 'background:url(https://tracker.example)',
    });
    sanitize(new FakeElement('body', {}, [img]));
    expect(img.attributes).toEqual([{ name: 'src', value: 'data:image/png;base64,AAAA' }]);
  });

  test('keeps http, https, mailto, and fragment links', () => {
    const links = ['http://a.example', 'https://a.example', 'mailto:a@b.c', '#_Toc1', 'HTTPS://A.EXAMPLE'].map(
      (href) => new FakeElement('a', { href }),
    );
    sanitize(new FakeElement('body', {}, links));
    expect(links.map((l) => l.attr('href'))).toEqual([
      'http://a.example',
      'https://a.example',
      'mailto:a@b.c',
      '#_Toc1',
      'HTTPS://A.EXAMPLE',
    ]);
  });

  test('removes javascript, obfuscated javascript, data, and relative hrefs', () => {
    const hrefs = ['javascript:alert(1)', ' java\tscript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,x', 'vbscript:x', 'page.html'];
    const links = hrefs.map((href) => new FakeElement('a', { href }));
    sanitize(new FakeElement('body', {}, links));
    expect(links.map((l) => l.attr('href'))).toEqual(hrefs.map(() => undefined));
  });

  test('keeps embedded data images on img but not elsewhere', () => {
    const img = new FakeElement('img', { src: 'data:image/png;base64,AAAA' });
    const link = new FakeElement('a', { href: 'data:image/png;base64,AAAA' });
    const video = new FakeElement('video', { src: 'data:image/png;base64,AAAA' });
    sanitize(new FakeElement('body', {}, [img, link, video]));
    expect(img.attr('src')).toBe('data:image/png;base64,AAAA');
    expect(link.attr('href')).toBeUndefined();
    expect(video.attr('src')).toBeUndefined();
  });

  test('removes every remote resource URL, so opening a document fetches nothing', () => {
    const images = ['https://tracker.example/a.png', 'http://tracker.example/a.png', '//tracker.example/a.png'].map(
      (src) => new FakeElement('img', { src }),
    );
    const cell = new FakeElement('td', { background: 'https://tracker.example/bg.png' });
    const video = new FakeElement('video', { poster: 'https://tracker.example/p.png' });
    const quote = new FakeElement('blockquote', { cite: 'https://a.example/source' });
    sanitize(new FakeElement('body', {}, [...images, cell, video, quote]));
    expect(images.map((img) => img.attr('src'))).toEqual([undefined, undefined, undefined]);
    expect(cell.attr('background')).toBeUndefined();
    expect(video.attr('poster')).toBeUndefined();
    // A link target is fetched only when the user taps it.
    expect(quote.attr('cite')).toBe('https://a.example/source');
  });

  test('scrubs xlink:href, srcset, and formaction', () => {
    const el = new FakeElement('a', {
      'xlink:href': 'javascript:alert(1)',
      srcset: 'https://a.example/x.png 1x',
      formaction: 'https://a.example',
    });
    sanitize(new FakeElement('body', {}, [el]));
    expect(el.attributes).toEqual([]);
  });
});

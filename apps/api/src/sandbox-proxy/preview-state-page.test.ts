import { describe, expect, test } from 'bun:test';
import {
  PREVIEW_STATE_HEADER,
  previewStateCopy,
  previewStatePage,
  type PreviewState,
} from './preview-state-page';

const ALL: PreviewState[] = [
  'signed-out',
  'forbidden',
  'unknown',
  'starting',
  'not-listening',
  'unreachable',
];

const BASE = {
  returnTo: 'https://dev-p8081-sbx-a.p.kortix.com/learn',
  frontendUrl: 'https://dev.kortix.com',
};

describe('every preview state renders a page a person can read', () => {
  test('all six states produce a complete, titled document', () => {
    for (const state of ALL) {
      const html = previewStatePage({ ...BASE, state, port: 8081 });
      expect(html).toStartWith('<!doctype html>');
      expect(html).toContain('</html>');
      // The page escapes everything it prints, its own copy included — hence
      // the apostrophe in "isn't" arriving as an entity.
      const title = previewStateCopy(state, 8081).title.replace(/'/g, '&#39;');
      expect(html).toContain(`<title>${title}</title>`);
      // Never a bare machine payload.
      expect(html).not.toContain('"error"');
    }
  });

  test('only the states a person can act on offer sign-in', () => {
    for (const state of ALL) {
      const html = previewStatePage({ ...BASE, state });
      const offers = previewStateCopy(state).signIn;
      expect(html.includes('/preview/authorize?to=')).toBe(offers);
      // A sign-in inside the session-panel iframe must break out of the frame.
      if (offers) expect(html).toContain('target="_top"');
    }
  });

  test('only the states that resolve on their own retry themselves', () => {
    for (const state of ALL) {
      const html = previewStatePage({ ...BASE, state });
      expect(html.includes('location.reload()')).toBe(previewStateCopy(state).autoRetry);
    }
  });

  test('a state that will never fix itself offers no false hope', () => {
    const html = previewStatePage({ ...BASE, state: 'unknown' });
    expect(html).toContain('no longer available');
    expect(html).not.toContain('location.reload()');
    expect(html).not.toContain('/preview/authorize');
  });

  test('the port is named when we know it, and never printed as undefined', () => {
    expect(previewStatePage({ ...BASE, state: 'not-listening', port: 8081 })).toContain('port 8081');
    const noPort = previewStatePage({ ...BASE, state: 'not-listening' });
    expect(noPort).not.toContain('undefined');
    expect(noPort).toContain('Nothing is listening yet');
  });

  test('the sign-in hand-off carries where the person was going', () => {
    const html = previewStatePage({ ...BASE, state: 'signed-out' });
    expect(html).toContain(encodeURIComponent(BASE.returnTo));
  });

  test('without a frontend URL there is no dead sign-in button', () => {
    const html = previewStatePage({ ...BASE, state: 'signed-out', frontendUrl: '' });
    expect(html).not.toContain('/preview/authorize');
    expect(html).not.toContain('href=""');
  });

  test('the page escapes what it echoes back', () => {
    const html = previewStatePage({
      ...BASE,
      state: 'unknown',
      returnTo: 'https://x.test/"><script>alert(1)</script>',
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('it is self-contained — no external asset can fail to load', () => {
    const html = previewStatePage({ ...BASE, state: 'starting' });
    expect(html).not.toMatch(/<link[^>]+href="http/);
    expect(html).not.toMatch(/<script[^>]+src=/);
  });

  test('the state header name is stable for probes and logs', () => {
    expect(PREVIEW_STATE_HEADER).toBe('x-kortix-preview-state');
  });
});

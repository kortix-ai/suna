import { describe, expect, test } from 'bun:test';
import { previewStatePage, type PreviewState } from './preview-state-page';

// Literal copy, not the helper's own answer: a changed title or a state that
// starts offering sign-in is a product change this table must be edited for.
const STATES: Array<[PreviewState, string, boolean, boolean]> = [
  ['signed-out', 'Sign in to open this preview', true, false],
  ['forbidden', 'This preview address is not signed', true, false],
  ['unknown', 'This preview is no longer available', false, false],
  ['starting', 'Starting the sandbox', false, true],
  ['not-listening', 'Nothing is listening on port 8081 yet', false, true],
  ['unreachable', 'Port 8081 isn&#39;t responding', false, true],
];

const BASE = {
  returnTo: 'https://dev-p8081-sbx-a.p.kortix.com/learn',
  frontendUrl: 'https://dev.kortix.com',
};

describe('every preview state renders a page a person can read', () => {
  // Only the states a person can act on offer sign-in, and only the states
  // that resolve on their own retry themselves. A state that will never fix
  // itself offers neither.
  test.each(STATES)('%s: titled "%s", sign-in %p, auto-retry %p', (state, title, signIn, retry) => {
    const html = previewStatePage({ ...BASE, state, port: 8081 });
    expect(html).toStartWith('<!doctype html>');
    expect(html).toContain('</html>');
    // The page escapes everything it prints, its own copy included.
    expect(html).toContain(`<title>${title}</title>`);
    // Never a bare machine payload.
    expect(html).not.toContain('"error"');
    expect(html.includes('/preview/authorize?to=')).toBe(signIn);
    // A sign-in inside the session-panel iframe must break out of the frame.
    if (signIn) expect(html).toContain('target="_top"');
    expect(html.includes('location.reload()')).toBe(retry);
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
});

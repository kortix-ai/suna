import { afterEach, describe, expect, test } from 'bun:test';

import { POST_AUTH_INTENT_COOKIE } from './landing-destination';
import { navigationMayCreateWorkspace } from './ensure-first-workspace';
import { hasPostAuthIntent, markPostAuthIntent } from './post-auth-intent';

/**
 * The landing door's CSRF gate must admit every real signup.
 *
 * `document.referrer` is cross-origin on the flows that create most accounts:
 * a magic link opened from webmail (https://mail.google.com/), an OAuth/SSO
 * IdP hop, and the /auth page's client-side redirect (which keeps the referrer
 * /auth was loaded with — often a search engine). A referrer-only gate demoted
 * exactly those users from /workspaces/start to the workspaces list. The post-auth
 * marker is the non-forgeable signal that admits them: only our own auth
 * completion code can set the cookie; a cross-site link cannot.
 */

type MutableGlobals = { document?: unknown; window?: unknown };
const g = globalThis as MutableGlobals;
const originalDocument = g.document;
const originalWindow = g.window;

function stubBrowser({ referrer, cookie = '' }: { referrer: string; cookie?: string }) {
  const state = { cookie };
  g.document = {
    referrer,
    get cookie() {
      return state.cookie;
    },
    set cookie(value: string) {
      const pair = value.split(';')[0];
      state.cookie = state.cookie ? `${state.cookie}; ${pair}` : pair;
    },
  };
  g.window = { location: { origin: 'https://dev.kortix.com', protocol: 'https:' } };
  return state;
}

afterEach(() => {
  g.document = originalDocument;
  g.window = originalWindow;
});

describe('navigationMayCreateWorkspace', () => {
  test('cross-origin referrer without the marker is refused', () => {
    stubBrowser({ referrer: 'https://evil.example/' });
    expect(navigationMayCreateWorkspace()).toBe(false);
  });

  test('a webmail magic-link arrival provisions once the marker is set', () => {
    stubBrowser({
      referrer: 'https://mail.google.com/',
      cookie: `${POST_AUTH_INTENT_COOKIE}=1`,
    });
    expect(navigationMayCreateWorkspace()).toBe(true);
  });

  test('empty referrer (typed URL, bookmark) is genuine intent', () => {
    stubBrowser({ referrer: '' });
    expect(navigationMayCreateWorkspace()).toBe(true);
  });

  test('same-origin referrer is genuine intent', () => {
    stubBrowser({ referrer: 'https://dev.kortix.com/auth' });
    expect(navigationMayCreateWorkspace()).toBe(true);
  });

  test('no DOM (server render) never creates', () => {
    g.document = undefined;
    expect(navigationMayCreateWorkspace()).toBe(false);
  });
});

describe('post-auth intent marker', () => {
  test('markPostAuthIntent writes the cookie hasPostAuthIntent reads', () => {
    stubBrowser({ referrer: 'https://accounts.google.com/' });
    expect(hasPostAuthIntent()).toBe(false);
    expect(navigationMayCreateWorkspace()).toBe(false);
    markPostAuthIntent();
    expect(hasPostAuthIntent()).toBe(true);
    expect(navigationMayCreateWorkspace()).toBe(true);
  });

  test('a cookie with any other value does not count', () => {
    stubBrowser({
      referrer: 'https://mail.google.com/',
      cookie: `${POST_AUTH_INTENT_COOKIE}=evil`,
    });
    expect(hasPostAuthIntent()).toBe(false);
    expect(navigationMayCreateWorkspace()).toBe(false);
  });
});

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { isAnalyticsExcludedPath, trackRouteChange } from './gtm';

// ─── Minimal browser stub ───────────────────────────────────────────────────
// No DOM library in this package. `trackRouteChange` reads `window.location`,
// `document.title`/`referrer`, and session storage through managed-storage.
type DataLayerWindow = {
  location: { origin: string; href: string; pathname: string };
  dataLayer: Record<string, unknown>[];
  sessionStorage: Storage;
};

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, String(value)),
  };
}

const g = globalThis as unknown as { window?: DataLayerWindow; document?: unknown };
let saved: { window?: DataLayerWindow; document?: unknown };

function visit(pathname: string, search: string) {
  const origin = 'https://app.example.com';
  const href = `${origin}${pathname}${search ? `?${search}` : ''}#frag`;
  g.window!.location = { origin, href, pathname };
  trackRouteChange(pathname, search);
}

beforeEach(() => {
  saved = { window: g.window, document: g.document };
  g.window = {
    location: { origin: '', href: '', pathname: '' },
    dataLayer: [],
    sessionStorage: memoryStorage(),
  };
  (g.window as unknown as { window: unknown }).window = g.window;
  g.document = { title: 'Kortix', referrer: '', documentElement: { lang: 'en' } };
});

afterEach(() => {
  g.window = saved.window;
  g.document = saved.document;
});

describe('GTM page_location never carries auth query strings', () => {
  test('an expired-link redirect keeps no email, return URL or other parameter', () => {
    visit('/auth', 'expired=true&email=person%40example.com&returnUrl=%2Fprojects%2Fp1');

    const event = g.window!.dataLayer.find((entry) => entry.event === 'routeChange')!;
    expect(event.page_location).toBe('https://app.example.com/auth');
    expect(JSON.stringify(g.window!.dataLayer)).not.toContain('example.com/projects');
    expect(JSON.stringify(g.window!.dataLayer)).not.toContain('person');
  });

  test('campaign parameters survive', () => {
    visit('/', 'utm_source=newsletter&utm_campaign=launch&email=person%40example.com');

    const event = g.window!.dataLayer.find((entry) => entry.event === 'routeChange')!;
    expect(event.page_location).toBe(
      'https://app.example.com/?utm_source=newsletter&utm_campaign=launch',
    );
  });

  test('the next page_referrer is the sanitized previous page, without query or hash', () => {
    visit('/auth', 'email=person%40example.com');
    visit('/', '');

    const events = g.window!.dataLayer.filter((entry) => entry.event === 'routeChange');
    expect(events[1]!.page_referrer).toBe('https://app.example.com/auth');
  });
});

describe('isAnalyticsExcludedPath', () => {
  test('excludes signed-in and capability-token pages, with or without a locale', () => {
    for (const path of [
      '/projects',
      '/projects/p1/sessions/s1',
      '/admin',
      '/admin/accounts',
      '/secret-intake/tok',
      '/de/secret-intake/tok',
      '/connect/tok',
      '/share/session/tok',
      '/settings/billing',
      '/slack/login/tok',
    ]) {
      expect(isAnalyticsExcludedPath(path), path).toBe(true);
    }
  });

  test('keeps marketing, auth and checkout pages', () => {
    for (const path of ['/', '/pricing', '/de/pricing', '/auth', '/checkout', '/projectsx']) {
      expect(isAnalyticsExcludedPath(path), path).toBe(false);
    }
  });
});

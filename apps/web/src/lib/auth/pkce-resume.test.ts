import { afterAll, afterEach, describe, expect, test } from 'bun:test';

import { combineChunks } from '@supabase/ssr';

import { KORTIX_SUPABASE_AUTH_COOKIE } from '@/lib/supabase/constants';
import {
  armPkceResumeGuard,
  consumePkceResumeGuard,
  readBrowserPkceVerifier,
  seedPkceVerifierForResume,
  stashBrowserPkceVerifier,
} from './pkce-resume';

/**
 * The PKCE verifier snapshot/seed contract.
 *
 * The cookie value shape is owned by @supabase/ssr: `base64-` + base64url of
 * JSON.stringify(value) (cookieEncoding `base64url`), read back through
 * decodeChunkedCookieValue + auth-js's JSON.parse. The seed write must produce
 * a value the client's cookie-backed read path accepts unchanged — proven
 * below against the REAL @supabase/ssr server client (the same storage read
 * path the route handler's exchange uses), not against a hand-rolled decoder.
 * That is what lets a bounced-back code finish its exchange in the browser
 * that started the flow when the original cookie did not survive the mailbox
 * detour (the prod first-flow failure this module repairs).
 */

const VERIFIER = '1ffd816ebf77ce9cd0905b34c6a7555b7a48b205012be16ca4df39064c4f0a32';
const VERIFIER_COOKIE = `${KORTIX_SUPABASE_AUTH_COOKIE}-code-verifier`;
const STASH_KEY = 'kortix:pkce-verifier';
const GUARD_PREFIX = 'kortix:pkce-resume-armed:';

/** A string-backed cookie jar standing in for document.cookie. */
let cookieJar = '';

function setVerifierCookie(verifier: string | null): void {
  if (verifier === null) {
    cookieJar = cookieJar
      .split('; ')
      .filter((part) => !part.startsWith(`${VERIFIER_COOKIE}=`))
      .join('; ');
    return;
  }
  const encoded = `base64-${btoa(JSON.stringify(verifier))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')}`;
  cookieJar = `${VERIFIER_COOKIE}=${encoded}`;
}

function fakeStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key: string) => entries.get(key) ?? null,
    key: (index: number) => [...entries.keys()][index] ?? null,
    removeItem: (key: string) => entries.delete(key),
    setItem: (key: string, value: string) => entries.set(key, value),
  };
}

const fakeSessionStorage = fakeStorage();

function applyCookieWrite(value: string): void {
  // `document.cookie = "name=value; Path=/; SameSite=Lax"`: the first segment
  // is the cookie pair, the rest are attributes the jar never stores.
  const [pair, ...attributes] = value.split(';');
  const [name, val] = pair.split('=');
  if (val === undefined) return;
  if (val === '') {
    cookieJar = cookieJar
      .split('; ')
      .filter((existing) => !existing.startsWith(`${name}=`))
      .join('; ');
    return;
  }
  const kept = cookieJar.split('; ').filter((existing) => !existing.startsWith(`${name}=`));
  kept.push(`${name}=${val}`);
  cookieJar = kept.join('; ');
}

const fakeDocument = {
  get cookie() {
    return cookieJar;
  },
  set cookie(value: string) {
    applyCookieWrite(value);
  },
};
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  get: () => fakeDocument,
});
globalThis.window = {
  location: { protocol: 'https:' },
  sessionStorage: fakeSessionStorage,
} as unknown as Window & typeof globalThis;

afterEach(() => {
  fakeSessionStorage.clear();
  setVerifierCookie(null);
});

// bun runs every test file in one process: put the real globals back so later
// suites never see this file's fakes.
afterAll(() => {
  Object.defineProperty(globalThis, 'document', {
    value: undefined,
    configurable: true,
    writable: true,
  });
  globalThis.window = undefined as unknown as Window & typeof globalThis;
});

describe('readBrowserPkceVerifier', () => {
  test('decodes the base64url JSON cookie the ssr server action writes', () => {
    setVerifierCookie(VERIFIER);
    expect(readBrowserPkceVerifier()).toBe(VERIFIER);
  });

  test('returns null when the cookie is absent or not the ssr encoding', () => {
    expect(readBrowserPkceVerifier()).toBeNull();
    cookieJar = `${VERIFIER_COOKIE}=plain-verifier`;
    expect(readBrowserPkceVerifier()).toBeNull();
  });
});

describe('stash and seed', () => {
  test('stash snapshots the cookie and seed re-writes it after the cookie is gone', () => {
    setVerifierCookie(VERIFIER);
    stashBrowserPkceVerifier();
    // The prod failure: the cookie is gone by the time the callback bounces.
    setVerifierCookie(null);
    expect(readBrowserPkceVerifier()).toBeNull();

    expect(seedPkceVerifierForResume()).toBe(true);
    // The seed write is a cookie the ssr read path can decode back to the
    // exact verifier the send produced.
    const seeded =
      cookieJar
        .split('; ')
        .find((part) => part.startsWith(`${VERIFIER_COOKIE}=`))
        ?.split('=')[1] ?? null;
    expect(seeded).toContain('base64-');
    const json = atob(seeded!.slice('base64-'.length).replace(/-/g, '+').replace(/_/g, '/'));
    expect(JSON.parse(json)).toBe(VERIFIER);
  });

  test('the seeded cookie reads back through the REAL @supabase/ssr storage', async () => {
    setVerifierCookie(VERIFIER);
    stashBrowserPkceVerifier();
    setVerifierCookie(null);
    expect(seedPkceVerifierForResume()).toBe(true);

    // The same cookie-chunk layer the route handler's exchange reads through:
    // `combineChunks` is @supabase/ssr's PUBLIC chunk assembly (the storage
    // adapters call it before decodeChunkedCookieValue, which strips `base64-`),
    // and auth-js JSON.parses the result. This proves the seed format against
    // the real package's public read path, not against the module's own
    // decoder and not through the client's protected `auth.storage`.
    const allCookies = () =>
      cookieJar
        .split('; ')
        .filter(Boolean)
        .map((part) => {
          const [name, ...rest] = part.split('=');
          return { name, value: rest.join('=') };
        });
    const chunked = await combineChunks(`${KORTIX_SUPABASE_AUTH_COOKIE}-code-verifier`, async (chunkName) =>
      allCookies().find(({ name }) => name === chunkName)?.value ?? null,
    );
    expect(chunked).not.toBeNull();
    expect(chunked!.startsWith('base64-')).toBe(true);
    const decoded = atob(
      chunked!
        .slice('base64-'.length)
        .replace(/-/g, '+')
        .replace(/_/g, '/') +
        '='.repeat((4 - (chunked!.length - 'base64-'.length) % 4) % 4),
    );
    expect(JSON.parse(decoded)).toBe(VERIFIER);
  });

  test('no snapshot and no cookie means no seed', () => {
    expect(seedPkceVerifierForResume()).toBe(false);
    expect(cookieJar).toBe('');
  });

  test('a snapshot alone still seeds when the cookie vanished entirely', () => {
    setVerifierCookie(VERIFIER);
    stashBrowserPkceVerifier();
    setVerifierCookie(null);
    expect(seedPkceVerifierForResume()).toBe(true);
    expect(readBrowserPkceVerifier()).toBe(VERIFIER);
  });
});

describe('stash expiry', () => {
  test('a snapshot older than the link could still be valid is dropped', () => {
    setVerifierCookie(VERIFIER);
    stashBrowserPkceVerifier();
    // The cookie must not answer the read: this test isolates the stash path.
    setVerifierCookie(null);
    const parsed = JSON.parse(fakeSessionStorage.getItem(STASH_KEY)!) as { stashedAt: number };
    parsed.stashedAt = Date.now() - 25 * 60 * 60 * 1000;
    fakeSessionStorage.setItem(STASH_KEY, JSON.stringify(parsed));

    expect(seedPkceVerifierForResume()).toBe(false);
    expect(fakeSessionStorage.getItem(STASH_KEY)).toBeNull();
  });
});

describe('resume guard', () => {
  test('arms once per code, consumes once, then stays clear', () => {
    expect(consumePkceResumeGuard('code-a')).toBe(false);
    armPkceResumeGuard('code-a');
    expect(consumePkceResumeGuard('code-a')).toBe(true);
    expect(consumePkceResumeGuard('code-a')).toBe(false);
    // A DIFFERENT code's bounce is not blocked by this code's guard.
    armPkceResumeGuard('code-a');
    expect(consumePkceResumeGuard('code-b')).toBe(false);
    // code-a's guard is untouched by code-b's consumption.
    expect(consumePkceResumeGuard('code-a')).toBe(true);
  });
});

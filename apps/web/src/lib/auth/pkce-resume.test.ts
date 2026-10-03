import { afterAll, afterEach, describe, expect, test } from 'bun:test';

import { KORTIX_SUPABASE_AUTH_COOKIE } from '@/lib/supabase/constants';
import {
  type PkceResumeClient,
  clearStashedPkceVerifier,
  readBrowserPkceVerifier,
  resumePkceExchange,
  stashBrowserPkceVerifier,
} from './pkce-resume';

/**
 * The PKCE verifier snapshot/resume contract.
 *
 * The cookie value shape is owned by @supabase/ssr: `base64-` + base64url of
 * JSON.stringify(value) (cookieEncoding `base64url`), read back through
 * decodeChunkedCookieValue + auth-js's JSON.parse. The seed write must produce
 * a value the client's cookie-backed read path accepts unchanged — that
 * symmetry is what lets a bounced-back code finish its exchange in the browser
 * that started the flow when the original cookie did not survive the mailbox
 * detour (the prod first-flow failure this module repairs).
 */

const VERIFIER = '1ffd816ebf77ce9cd0905b34c6a7555b7a48b205012be16ca4df39064c4f0a32';
// The module reads the cookie through the same constant; the test env's
// APP_URL (bun auto-loads apps/web/.env) may scope it to a port.
const VERIFIER_COOKIE = `${KORTIX_SUPABASE_AUTH_COOKIE}-code-verifier`;
const STASH_KEY = 'kortix:pkce-verifier';

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

const originalDocument = globalThis.document;
const originalWindow = globalThis.window;

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
  for (const part of value.split(';')) {
    const [name, val] = part.split('=');
    if (val === '') {
      cookieJar = cookieJar
        .split('; ')
        .filter((existing) => !existing.startsWith(`${name}=`))
        .join('; ');
    } else {
      const kept = cookieJar.split('; ').filter((existing) => !existing.startsWith(`${name}=`));
      kept.push(`${name}=${val}`);
      cookieJar = kept.join('; ');
    }
  }
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
    value: originalDocument,
    configurable: true,
    writable: true,
  });
  globalThis.window = originalWindow;
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

describe('stash and resume', () => {
  test('stash snapshots the cookie and resume re-seeds it after the cookie is gone', async () => {
    setVerifierCookie(VERIFIER);
    stashBrowserPkceVerifier();
    // The prod failure: the cookie is gone by the time the callback bounces.
    setVerifierCookie(null);
    expect(readBrowserPkceVerifier()).toBeNull();

    let seededCookie: string | null = null;
    const exchanges: Array<{ authCode: string; options: unknown }> = [];
    const client: PkceResumeClient = {
      auth: {
        exchangeCodeForSession: async (authCode: string, options?: { flowId?: string }) => {
          exchanges.push({ authCode, options });
          seededCookie =
            cookieJar
              .split('; ')
              .find((part) => part.startsWith(`${VERIFIER_COOKIE}=`)) ?? null;
          return { data: { session: { access_token: 'at' }, user: { id: 'u1' } }, error: null };
        },
      },
    };

    const result = await resumePkceExchange('fresh-code', client);
    expect(result.resumed).toBe(true);
    expect(exchanges).toEqual([{ authCode: 'fresh-code', options: undefined }]);
    // The seed write is a cookie the ssr read path can decode back to the
    // exact verifier the send produced.
    expect(seededCookie).toContain('base64-');
    const raw = seededCookie!.split('=')[1];
    const json = atob(raw.slice('base64-'.length).replace(/-/g, '+').replace(/_/g, '/'));
    expect(JSON.parse(json)).toBe(VERIFIER);
    // A spent flow's snapshot is cleared, not replayable.
    expect(fakeSessionStorage.getItem(STASH_KEY)).toBeNull();
  });

  test('a failed exchange reports the message instead of pretending success', async () => {
    setVerifierCookie(VERIFIER);
    stashBrowserPkceVerifier();
    const client: PkceResumeClient = {
      auth: {
        exchangeCodeForSession: async () => ({
          data: { session: null, user: null },
          error: { message: 'invalid request: code verifier mismatch' },
        }),
      },
    };
    const result = await resumePkceExchange('fresh-code', client);
    expect(result.resumed).toBe(false);
    expect(result.message).toBe('invalid request: code verifier mismatch');
  });

  test('no snapshot and no cookie means no resume, not an exchange attempt', async () => {
    const exchanges: unknown[] = [];
    const client: PkceResumeClient = {
      auth: {
        exchangeCodeForSession: async () => {
          exchanges.push(1);
          return { data: { session: null }, error: null };
        },
      },
    };
    const result = await resumePkceExchange('fresh-code', client);
    expect(result).toEqual({ resumed: false });
    expect(exchanges).toHaveLength(0);
  });
});

describe('stash expiry', () => {
  test('a snapshot older than the TTL is dropped', async () => {
    setVerifierCookie(VERIFIER);
    stashBrowserPkceVerifier();
    const parsed = JSON.parse(fakeSessionStorage.getItem(STASH_KEY)!) as { stashedAt: number };
    parsed.stashedAt = Date.now() - 16 * 60 * 1000;
    fakeSessionStorage.setItem(STASH_KEY, JSON.stringify(parsed));

    const client: PkceResumeClient = {
      auth: {
        exchangeCodeForSession: async () => ({ data: { session: null }, error: null }),
      },
    };
    const result = await resumePkceExchange('fresh-code', client);
    expect(result.resumed).toBe(false);
    expect(fakeSessionStorage.getItem(STASH_KEY)).toBeNull();
  });
});

describe('clearStashedPkceVerifier', () => {
  test('removes the snapshot', () => {
    stashBrowserPkceVerifier();
    clearStashedPkceVerifier();
    expect(fakeSessionStorage.getItem(STASH_KEY)).toBeNull();
  });
});


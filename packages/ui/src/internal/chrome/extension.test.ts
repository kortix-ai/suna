import { afterEach, describe, expect, test } from 'bun:test';

import {
  apiOrigin,
  CHROME_INSTALL_DOCS_PATH,
  CHROME_STORE_LISTED,
  chromeSettingsLink,
  connectExtension,
  isChromiumBrowser,
  KORTIX_EXTENSION_ID,
  KORTIX_EXTENSION_STORE_URL,
  pingExtension,
} from './extension';

type Reply = (response: unknown) => void;
type Send = (id: string, message: { type: string; apiUrl?: string }, reply: Reply) => void;

function fakeChrome(send: Send, lastError?: { message: string }) {
  (globalThis as Record<string, unknown>).chrome = {
    runtime: {
      sendMessage: send,
      get lastError() {
        return lastError;
      },
    },
  };
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).chrome;
});

describe('store listing', () => {
  test('the listing is not public: no surface offers Add to Chrome', () => {
    expect(CHROME_STORE_LISTED).toBe(false);
    expect(CHROME_INSTALL_DOCS_PATH).toBe('/docs/connect/chrome');
  });
  test('the link to copy opens Settings → Kortix in Chrome', () => {
    expect(chromeSettingsLink('https://app.example.com')).toBe('https://app.example.com/settings/chrome');
  });
});

describe('constants', () => {
  test('the store URL points at the extension id', () => {
    expect(KORTIX_EXTENSION_ID).toBe('gefbbnjgoiljpbnalgafbhbfdhikgjek');
    expect(KORTIX_EXTENSION_STORE_URL).toBe(
      `https://chromewebstore.google.com/detail/${KORTIX_EXTENSION_ID}`,
    );
  });
});

describe('isChromiumBrowser', () => {
  const chrome = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36';
  test('accepts Chrome, Edge, Brave and Arc user agents', () => {
    expect(isChromiumBrowser(chrome)).toBe(true);
    expect(isChromiumBrowser(`${chrome} Edg/130.0.0.0`)).toBe(true);
  });
  test('rejects Safari, Firefox and the Kortix desktop shell', () => {
    expect(isChromiumBrowser('Mozilla/5.0 (Macintosh) AppleWebKit/605 Version/17 Safari/605')).toBe(false);
    expect(isChromiumBrowser('Mozilla/5.0 (Macintosh; rv:130.0) Gecko/20100101 Firefox/130.0')).toBe(false);
    expect(isChromiumBrowser(`${chrome} Electron/33.0.0`)).toBe(false);
  });
  test('rejects Chrome on iOS, which cannot run extensions', () => {
    expect(isChromiumBrowser('Mozilla/5.0 (iPhone) AppleWebKit/605 CriOS/130 Mobile Safari/604')).toBe(false);
  });
});

describe('apiOrigin', () => {
  test('keeps only the origin of an absolute backend URL', () => {
    expect(apiOrigin('http://localhost:8008/v1', 'http://localhost:3000')).toBe('http://localhost:8008');
    expect(apiOrigin('https://api.kortix.com/v1/', 'https://kortix.com')).toBe('https://api.kortix.com');
  });
  test('resolves a same-origin relative backend URL against the page', () => {
    expect(apiOrigin('/v1', 'https://dev.kortix.com')).toBe('https://dev.kortix.com');
  });
  test('is empty when the backend URL is empty or invalid', () => {
    expect(apiOrigin('', 'https://kortix.com')).toBe('');
    expect(apiOrigin('http://', 'https://kortix.com')).toBe('');
  });
});

describe('pingExtension', () => {
  test('returns null when the page has no chrome.runtime', async () => {
    expect(await pingExtension()).toBeNull();
  });

  test('sends kortix.ping to the extension id and returns the reply', async () => {
    const seen: Array<[string, string]> = [];
    fakeChrome((id, message, reply) => {
      seen.push([id, message.type]);
      reply({ ok: true, version: '1.0.0', connected: false, apiUrl: null, chromeId: null });
    });
    const status = await pingExtension();
    expect(seen).toEqual([[KORTIX_EXTENSION_ID, 'kortix.ping']]);
    expect(status).toEqual({ version: '1.0.0', connected: false, apiUrl: null, chromeId: null });
  });

  test('returns null when chrome.runtime.lastError is set (extension not installed)', async () => {
    fakeChrome((_id, _message, reply) => reply(undefined), { message: 'Could not establish connection.' });
    expect(await pingExtension()).toBeNull();
  });

  test('returns null when the extension answers ok:false', async () => {
    fakeChrome((_id, _message, reply) => reply({ ok: false }));
    expect(await pingExtension()).toBeNull();
  });

  test('returns null after the timeout when nothing answers', async () => {
    fakeChrome(() => {});
    expect(await pingExtension(20)).toBeNull();
  });

  test('returns null when sendMessage throws', async () => {
    fakeChrome(() => {
      throw new Error('bad id');
    });
    expect(await pingExtension()).toBeNull();
  });
});

describe('connectExtension', () => {
  test('sends kortix.connect with the api URL and returns the browser id', async () => {
    let sent = null as { type: string; apiUrl?: string } | null;
    fakeChrome((_id, message, reply) => {
      sent = message;
      reply({ ok: true, chromeId: 'b1' });
    });
    expect(await connectExtension('http://localhost:8008')).toEqual({ ok: true, chromeId: 'b1' });
    expect(sent).toEqual({ type: 'kortix.connect', apiUrl: 'http://localhost:8008' });
  });

  test('returns the extension error', async () => {
    fakeChrome((_id, _message, reply) => reply({ ok: false, error: 'Sign-in was closed.' }));
    expect(await connectExtension('https://api.kortix.com')).toEqual({ ok: false, error: 'Sign-in was closed.' });
  });

  test('fails when the extension is missing', async () => {
    expect(await connectExtension('https://api.kortix.com')).toEqual({ ok: false, error: 'unavailable' });
  });
});

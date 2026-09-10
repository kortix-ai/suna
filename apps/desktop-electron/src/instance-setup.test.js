const { describe, it, expect } = require('bun:test');
const {
  PROBE_TIMEOUT_MS,
  normalizeInstanceUrl,
  isFreshProfile,
  needsInstanceSetup,
  describeDefaultInstance,
  explainNetError,
  probeInstance,
} = require('./instance-setup');

describe('normalizeInstanceUrl', () => {
  it('rejects empty input', () => {
    expect(normalizeInstanceUrl('')).toEqual({ ok: false, error: 'Enter the URL of your Kortix instance.' });
    expect(normalizeInstanceUrl('   ')).toMatchObject({ ok: false });
    expect(normalizeInstanceUrl(undefined)).toMatchObject({ ok: false });
  });

  it('adds https:// to a bare host and opens the product surface', () => {
    expect(normalizeInstanceUrl('kortix.acme.com')).toEqual({
      ok: true,
      url: 'https://kortix.acme.com/projects',
    });
  });

  it('adds http:// to a bare loopback host', () => {
    expect(normalizeInstanceUrl('localhost:3000')).toEqual({ ok: true, url: 'http://localhost:3000/projects' });
    expect(normalizeInstanceUrl('127.0.0.1:3000')).toEqual({ ok: true, url: 'http://127.0.0.1:3000/projects' });
  });

  it('keeps an explicit scheme, port, and path', () => {
    expect(normalizeInstanceUrl(' http://10.0.0.5:8080 ')).toEqual({ ok: true, url: 'http://10.0.0.5:8080/projects' });
    expect(normalizeInstanceUrl('https://kortix.acme.com/projects/abc')).toEqual({
      ok: true,
      url: 'https://kortix.acme.com/projects/abc',
    });
  });

  it('drops the query and fragment', () => {
    expect(normalizeInstanceUrl('https://kortix.acme.com/?utm=x#top')).toEqual({
      ok: true,
      url: 'https://kortix.acme.com/projects',
    });
  });

  it('rejects non-http schemes', () => {
    expect(normalizeInstanceUrl('file:///etc/passwd')).toEqual({ ok: false, error: 'The URL must start with http:// or https://.' });
    expect(normalizeInstanceUrl('javascript:alert(1)')).toMatchObject({ ok: false });
    expect(normalizeInstanceUrl('kortix://auth/callback')).toMatchObject({ ok: false });
  });

  it('rejects embedded credentials, which would be stored in plain text', () => {
    expect(normalizeInstanceUrl('https://user:pw@kortix.acme.com')).toEqual({
      ok: false,
      error: 'Remove the username and password from the URL.',
    });
  });

  it('rejects input that is not a URL', () => {
    expect(normalizeInstanceUrl('https://')).toEqual({ ok: false, error: 'This is not a valid URL.' });
    expect(normalizeInstanceUrl('not a url')).toEqual({ ok: false, error: 'This is not a valid URL.' });
  });
});

describe('isFreshProfile', () => {
  it('is fresh when the profile directory is missing or empty', () => {
    expect(isFreshProfile(null)).toBe(true);
    expect(isFreshProfile([])).toBe(true);
    expect(isFreshProfile(['.DS_Store'])).toBe(true);
  });

  it('is not fresh when any earlier launch left state behind', () => {
    expect(isFreshProfile(['Preferences'])).toBe(false);
    expect(isFreshProfile(['.DS_Store', 'window_state.json'])).toBe(false);
  });
});

describe('needsInstanceSetup', () => {
  it('asks only while setup is pending and nothing chose a URL', () => {
    expect(needsInstanceSetup({ pending: true, override: null, envUrl: undefined })).toBe(true);
  });

  it('never asks an existing install (no pending marker)', () => {
    expect(needsInstanceSetup({ pending: false, override: null, envUrl: undefined })).toBe(false);
  });

  it('skips when a saved override or KORTIX_DESKTOP_URL already chose the URL', () => {
    expect(needsInstanceSetup({ pending: true, override: 'https://kortix.acme.com/projects' })).toBe(false);
    expect(needsInstanceSetup({ pending: true, override: null, envUrl: 'http://localhost:3000/projects' })).toBe(false);
  });
});

describe('describeDefaultInstance', () => {
  it('names Kortix Cloud for kortix.com hosts', () => {
    expect(describeDefaultInstance('https://kortix.com/projects')).toEqual({ title: 'Kortix Cloud', host: 'kortix.com' });
    expect(describeDefaultInstance('https://dev.kortix.com/projects')).toEqual({
      title: 'Kortix Cloud',
      host: 'dev.kortix.com',
    });
  });

  it('falls back to a neutral title for any other default', () => {
    expect(describeDefaultInstance('http://localhost:3000/projects')).toEqual({ title: 'Default', host: 'localhost:3000' });
    expect(describeDefaultInstance('https://evilkortix.com/projects')).toEqual({ title: 'Default', host: 'evilkortix.com' });
    expect(describeDefaultInstance('garbage')).toEqual({ title: 'Default', host: 'garbage' });
  });
});

describe('explainNetError', () => {
  it('maps Chromium network errors to plain sentences', () => {
    expect(explainNetError('kortix.acme.com', 'net::ERR_NAME_NOT_RESOLVED')).toBe(
      'kortix.acme.com could not be found. Check the address.',
    );
    expect(explainNetError('localhost:3000', 'ERR_CONNECTION_REFUSED')).toBe('localhost:3000 refused the connection.');
    expect(explainNetError('kortix.com', 'ERR_INTERNET_DISCONNECTED')).toBe('This computer is offline.');
    expect(explainNetError('kortix.acme.com', 'net::ERR_CERT_AUTHORITY_INVALID')).toBe(
      'The security certificate of kortix.acme.com is not trusted.',
    );
  });

  it('keeps the raw code for errors it does not know', () => {
    expect(explainNetError('kortix.acme.com', 'net::ERR_QUIC_PROTOCOL_ERROR')).toBe(
      'kortix.acme.com did not load (ERR_QUIC_PROTOCOL_ERROR).',
    );
    expect(explainNetError('kortix.acme.com', '')).toBe('kortix.acme.com did not load.');
  });
});

describe('probeInstance', () => {
  const URL_ = 'https://kortix.acme.com/projects';

  it('treats any HTTP response as reachable, including 401 and 404', async () => {
    for (const status of [200, 307, 401, 404, 503]) {
      const res = await probeInstance(URL_, { fetch: async () => ({ status }) });
      expect(res).toEqual({ ok: true, status });
    }
  });

  it('sends a HEAD request without credentials', async () => {
    let seen;
    await probeInstance(URL_, {
      fetch: async (url, init) => {
        seen = { url, method: init.method, credentials: init.credentials, hasSignal: !!init.signal };
        return { status: 200 };
      },
    });
    expect(seen).toEqual({ url: URL_, method: 'HEAD', credentials: 'omit', hasSignal: true });
  });

  it('explains a network failure', async () => {
    const res = await probeInstance(URL_, {
      fetch: async () => {
        throw new Error('net::ERR_NAME_NOT_RESOLVED');
      },
    });
    expect(res).toEqual({ ok: false, error: 'kortix.acme.com could not be found. Check the address.' });
  });

  it('times out a request that never answers', async () => {
    const res = await probeInstance(URL_, {
      timeoutMs: 20,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });
    expect(res).toEqual({ ok: false, error: 'kortix.acme.com did not respond within 1 s.' });
    expect(PROBE_TIMEOUT_MS).toBe(8_000);
  });
});

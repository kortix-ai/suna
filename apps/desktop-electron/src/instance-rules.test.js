const { describe, it, expect } = require('bun:test');
const {
  PROBE_TIMEOUT_MS,
  normalizeInstanceUrl,
  describeDefaultInstance,
  explainNetError,
  probeInstance,
  checkInstanceChoice,
} = require('./instance-rules');

const INSTANCE = 'https://kortix.acme.com/projects';
const reachable = async () => ({ status: 200 });
const unreachable = async () => {
  throw new Error('net::ERR_NAME_NOT_RESOLVED');
};
const mustNotFetch = async () => {
  throw new Error('fetch must not be called');
};

describe('normalizeInstanceUrl', () => {
  it('rejects empty input', () => {
    expect(normalizeInstanceUrl('')).toEqual({ ok: false, error: 'Enter the URL of your Kortix instance.' });
    expect(normalizeInstanceUrl('   ')).toMatchObject({ ok: false });
    expect(normalizeInstanceUrl(undefined)).toMatchObject({ ok: false });
  });

  it('adds https:// to a bare host and opens the product surface', () => {
    expect(normalizeInstanceUrl('kortix.acme.com')).toEqual({ ok: true, url: INSTANCE });
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
    expect(normalizeInstanceUrl('https://kortix.acme.com/?utm=x#top')).toEqual({ ok: true, url: INSTANCE });
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
  it('treats any HTTP response as reachable, including 401 and 404', async () => {
    for (const status of [200, 307, 401, 404, 503]) {
      expect(await probeInstance(INSTANCE, { fetch: async () => ({ status }) })).toEqual({ ok: true, status });
    }
  });

  it('sends a HEAD request without credentials', async () => {
    let seen;
    await probeInstance(INSTANCE, {
      fetch: async (url, init) => {
        seen = { url, method: init.method, credentials: init.credentials, hasSignal: !!init.signal };
        return { status: 200 };
      },
    });
    expect(seen).toEqual({ url: INSTANCE, method: 'HEAD', credentials: 'omit', hasSignal: true });
  });

  it('explains a network failure', async () => {
    expect(await probeInstance(INSTANCE, { fetch: unreachable })).toEqual({
      ok: false,
      error: 'kortix.acme.com could not be found. Check the address.',
    });
  });

  it('times out a request that never answers', async () => {
    const res = await probeInstance(INSTANCE, {
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

describe('checkInstanceChoice', () => {
  it('accepts the default without a network request', async () => {
    expect(await checkInstanceChoice({ kind: 'default', url: 'ignored' }, { fetch: mustNotFetch })).toEqual({
      ok: true,
      choice: { kind: 'default' },
    });
  });

  it('rejects an invalid URL before any network request', async () => {
    expect(await checkInstanceChoice({ kind: 'custom', url: 'file:///x' }, { fetch: mustNotFetch })).toEqual({
      ok: false,
      error: 'The URL must start with http:// or https://.',
    });
  });

  it('returns the normalized URL of a reachable instance', async () => {
    expect(await checkInstanceChoice({ kind: 'custom', url: 'kortix.acme.com' }, { fetch: reachable })).toEqual({
      ok: true,
      choice: { kind: 'custom', url: INSTANCE },
    });
  });

  it('marks an unreachable instance so the page can offer Continue Anyway', async () => {
    expect(await checkInstanceChoice({ kind: 'custom', url: 'kortix.acme.com' }, { fetch: unreachable })).toEqual({
      ok: false,
      error: 'kortix.acme.com could not be found. Check the address.',
      unreachable: true,
    });
  });

  it('skips the reachability check when forced', async () => {
    expect(
      await checkInstanceChoice({ kind: 'custom', url: 'kortix.acme.com', force: true }, { fetch: mustNotFetch }),
    ).toEqual({ ok: true, choice: { kind: 'custom', url: INSTANCE } });
  });
});

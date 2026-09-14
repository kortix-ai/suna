const { describe, it, expect } = require('bun:test');
const {
  decideChallenge,
  parseStore,
  serializeStore,
  lookupHost,
  upsertHost,
  removeHost,
  REJECT_WINDOW_MS,
} = require('./basic-auth');

const HOST = 'dev.kortix.com';
const NOW = 1_000_000;

describe('decideChallenge', () => {
  it('prompts with the default user when nothing is known', () => {
    expect(decideChallenge({ host: HOST, now: NOW })).toEqual({
      action: 'prompt',
      user: 'kortix',
      error: null,
      dropStored: false,
    });
  });

  it('answers from env first, defaulting the user to kortix', () => {
    expect(
      decideChallenge({
        host: HOST,
        env: { password: 'pw' },
        stored: { user: 'u', password: 'stored' },
        now: NOW,
      }),
    ).toEqual({ action: 'answer', source: 'env', user: 'kortix', password: 'pw' });
    expect(
      decideChallenge({ host: HOST, env: { user: 'me', password: 'pw' }, now: NOW }),
    ).toMatchObject({ source: 'env', user: 'me' });
  });

  it('answers from the stored credential when env is unset', () => {
    expect(
      decideChallenge({ host: HOST, stored: { user: 'u', password: 'stored' }, now: NOW }),
    ).toEqual({ action: 'answer', source: 'stored', user: 'u', password: 'stored' });
  });

  it('treats a re-challenge inside the window as a rejection of the stored credential', () => {
    const res = decideChallenge({
      host: HOST,
      stored: { user: 'u', password: 'bad' },
      lastAnswer: { source: 'stored', at: NOW - 1_000 },
      now: NOW,
    });
    expect(res).toEqual({
      action: 'prompt',
      user: 'u',
      error: 'dev.kortix.com rejected the username or password.',
      dropStored: true,
    });
  });

  it('retries the stored credential silently once the window has passed', () => {
    const res = decideChallenge({
      host: HOST,
      stored: { user: 'u', password: 'ok' },
      lastAnswer: { source: 'stored', at: NOW - REJECT_WINDOW_MS },
      now: NOW,
    });
    expect(res).toMatchObject({ action: 'answer', source: 'stored' });
  });

  it('falls through to the dialog when the env credential is rejected, without dropping storage', () => {
    const res = decideChallenge({
      host: HOST,
      env: { user: 'ci', password: 'bad' },
      lastAnswer: { source: 'env', at: NOW - 5 },
      now: NOW,
    });
    expect(res).toEqual({
      action: 'prompt',
      user: 'ci',
      error: 'dev.kortix.com rejected the username or password.',
      dropStored: false,
    });
  });

  it('re-prompts with an error when a typed credential is rejected', () => {
    const res = decideChallenge({
      host: HOST,
      lastAnswer: { source: 'prompt', at: NOW - 5 },
      now: NOW,
    });
    expect(res).toMatchObject({ action: 'prompt', error: expect.stringContaining('rejected') });
    expect(res.dropStored).toBe(false);
  });

  it('does not silently retry a typed credential that was just rejected (it is now the stored one)', () => {
    const res = decideChallenge({
      host: HOST,
      stored: { user: 'kortix', password: 'typed-wrong' },
      lastAnswer: { source: 'prompt', at: NOW - 5 },
      now: NOW,
    });
    expect(res).toEqual({
      action: 'prompt',
      user: 'kortix',
      error: 'dev.kortix.com rejected the username or password.',
      dropStored: true,
    });
  });

  it('after a rejected env credential, still trusts a remembered one', () => {
    const res = decideChallenge({
      host: HOST,
      env: { password: 'bad' },
      stored: { user: 'kortix', password: 'good' },
      lastAnswer: { source: 'env', at: NOW - 5 },
      now: NOW,
    });
    expect(res).toEqual({ action: 'answer', source: 'stored', user: 'kortix', password: 'good' });
  });
});

describe('store', () => {
  it('round-trips through serialize/parse', () => {
    let store = parseStore(null);
    store = upsertHost(store, HOST, { user: 'kortix', secret: 'enc:abc' });
    const parsed = parseStore(serializeStore(store));
    expect(lookupHost(parsed, HOST)).toEqual({ user: 'kortix', secret: 'enc:abc' });
    expect(lookupHost(parsed, 'other')).toBeNull();
  });

  it('removes a host without touching the others', () => {
    let store = upsertHost(parseStore(null), HOST, { user: 'a', secret: 's1' });
    store = upsertHost(store, 'staging.kortix.com', { user: 'b', secret: 's2' });
    store = removeHost(store, HOST);
    expect(lookupHost(store, HOST)).toBeNull();
    expect(lookupHost(store, 'staging.kortix.com')).toEqual({ user: 'b', secret: 's2' });
  });

  it('discards corrupt, foreign-version, or malformed entries', () => {
    expect(parseStore('not json')).toEqual({ version: 1, hosts: {} });
    expect(parseStore(JSON.stringify({ version: 2, hosts: { a: { user: 'x', secret: 'y' } } }))).toEqual({
      version: 1,
      hosts: {},
    });
    expect(
      parseStore(
        JSON.stringify({ version: 1, hosts: { good: { user: 'x', secret: 'y' }, bad: { user: 1 } } }),
      ),
    ).toEqual({ version: 1, hosts: { good: { user: 'x', secret: 'y' } } });
  });
});

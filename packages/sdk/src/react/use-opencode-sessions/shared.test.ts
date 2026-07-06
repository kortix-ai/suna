import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  activeServerKey,
  canQueryOpenCodeSession,
  CACHE_SCOPE_GLOBAL,
  clearProjectProviderCache,
  getLSCache,
  LS_AGENTS,
  LS_PROVIDERS,
  LS_SESSIONS,
  setLSCache,
  unwrap,
} from './shared';
import { setCurrentRuntime } from '../../state/current-runtime';

// ============================================================================
// unwrap — the SDK-response { data, error } → value-or-throw helper shared by
// every hook in this directory.
// ============================================================================

describe('unwrap', () => {
  test('returns data when there is no error', () => {
    expect(unwrap({ data: { hello: 'world' } })).toEqual({ hello: 'world' });
  });

  test('prefers error.data.message', () => {
    expect(() => unwrap({ error: { data: { message: 'nested message' }, message: 'top message' } })).toThrow(
      'nested message',
    );
  });

  test('falls back to error.message when there is no error.data.message', () => {
    expect(() => unwrap({ error: { message: 'top message' } })).toThrow('top message');
  });

  test('falls back to error.error when there is no .message anywhere', () => {
    expect(() => unwrap({ error: { error: 'legacy error field' } })).toThrow('legacy error field');
  });

  test('a string error is used verbatim', () => {
    expect(() => unwrap({ error: 'plain string error' })).toThrow('plain string error');
  });

  test('an unrecognized object error falls back to a stringified JSON blob', () => {
    expect(() => unwrap({ error: { weird: 'shape' } })).toThrow('{"weird":"shape"}');
  });

  test('a falsy error (e.g. explicit null) takes the success/data path, not the throw path', () => {
    expect(unwrap({ data: 'ok', error: null as unknown as undefined })).toBe('ok');
  });

  test('uses the response status when the error is truthy but not an object/string', () => {
    // A truthy, non-object, non-string `error` (e.g. a bare number) skips the
    // message/data/JSON.stringify fallbacks entirely and hits the status tail.
    expect(() => unwrap({ error: 42, response: new Response(null, { status: 503 }) })).toThrow(
      'Server returned 503',
    );
  });
});

// ============================================================================
// canQueryOpenCodeSession — rejects Kortix's own project-session UUIDs (which
// aren't real opencode session ids and would 404 the opencode API).
// ============================================================================

describe('canQueryOpenCodeSession', () => {
  test('rejects null/undefined/empty', () => {
    expect(canQueryOpenCodeSession(null)).toBe(false);
    expect(canQueryOpenCodeSession(undefined)).toBe(false);
    expect(canQueryOpenCodeSession('')).toBe(false);
  });

  test('rejects a v4 UUID (the Kortix project-session id shape)', () => {
    expect(canQueryOpenCodeSession('550e8400-e29b-41d4-a716-446655440000')).toBe(false);
  });

  test('accepts a real opencode session id (ses_<...> shape)', () => {
    expect(canQueryOpenCodeSession('ses_01hzxk3n8g8g8g8g8g8g8g8g')).toBe(true);
  });

  test('accepts an arbitrary non-UUID string', () => {
    expect(canQueryOpenCodeSession('not-a-uuid-at-all')).toBe(true);
  });
});

// ============================================================================
// getLSCache / setLSCache / clearProjectProviderCache — the localStorage-backed
// per-family caches, scoped by the active sandbox id (or an explicit scope).
// `window`/`localStorage` don't exist in bun's default test environment, so
// both are stubbed with a minimal in-memory `Storage` implementation.
// ============================================================================

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) ?? null) : null;
  }
  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

interface GlobalWithDom {
  window?: unknown;
  localStorage?: Storage;
}

describe('getLSCache / setLSCache (localStorage stubbed)', () => {
  beforeEach(() => {
    (globalThis as GlobalWithDom).window = {};
    (globalThis as GlobalWithDom).localStorage = new MemoryStorage();
    setCurrentRuntime(null);
  });

  afterEach(() => {
    delete (globalThis as GlobalWithDom).window;
    delete (globalThis as GlobalWithDom).localStorage;
    setCurrentRuntime(null);
  });

  test('round-trips a value under the active-sandbox scope by default', () => {
    setCurrentRuntime('https://sbx.test', 'sandbox-1');
    setLSCache(LS_SESSIONS, [{ id: 'ses_1' }]);
    expect(getLSCache<Array<{ id: string }>>(LS_SESSIONS)).toEqual([{ id: 'ses_1' }]);
  });

  test('falls back to the "none" scope when there is no active sandbox', () => {
    expect(activeServerKey()).toBe('none');
    setLSCache(LS_SESSIONS, [{ id: 'ses_none' }]);
    expect(getLSCache<Array<{ id: string }>>(LS_SESSIONS)).toEqual([{ id: 'ses_none' }]);
  });

  test('an explicit scope overrides the active-sandbox default', () => {
    setCurrentRuntime('https://sbx.test', 'sandbox-1');
    setLSCache(LS_PROVIDERS, { all: [] }, CACHE_SCOPE_GLOBAL);
    // Not visible under the (different) active-sandbox scope...
    expect(getLSCache(LS_PROVIDERS)).toBeUndefined();
    // ...but is visible when read back with the same explicit scope.
    expect(getLSCache<{ all: unknown[] }>(LS_PROVIDERS, CACHE_SCOPE_GLOBAL)).toEqual({ all: [] });
  });

  test('different families never collide even under the same scope', () => {
    setLSCache(LS_SESSIONS, ['sessions-value']);
    setLSCache(LS_AGENTS, ['agents-value']);
    expect(getLSCache<string[]>(LS_SESSIONS)).toEqual(['sessions-value']);
    expect(getLSCache<string[]>(LS_AGENTS)).toEqual(['agents-value']);
  });

  test('an unknown family is a safe no-op miss', () => {
    expect(getLSCache('kortix_cache_unknown_family')).toBeUndefined();
  });

  test('clearProjectProviderCache removes both the native and gateway scoped entries', () => {
    setLSCache(LS_PROVIDERS, { all: ['native'] }, 'proj:p1:native');
    setLSCache(LS_PROVIDERS, { all: ['gateway'] }, 'proj:p1:gateway');
    clearProjectProviderCache('p1');
    expect(getLSCache(LS_PROVIDERS, 'proj:p1:native')).toBeUndefined();
    expect(getLSCache(LS_PROVIDERS, 'proj:p1:gateway')).toBeUndefined();
  });

  test('without window/localStorage stubbed, get/set are safe no-ops', () => {
    delete (globalThis as GlobalWithDom).window;
    delete (globalThis as GlobalWithDom).localStorage;
    expect(() => setLSCache(LS_SESSIONS, ['x'])).not.toThrow();
    expect(getLSCache(LS_SESSIONS)).toBeUndefined();
  });
});

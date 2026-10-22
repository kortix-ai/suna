import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  asRuntimeList,
  canQueryRuntimeSession,
  clearProjectProviderCache,
  unwrap,
} from './shared';
import { pruneAllRegisteredCaches } from '../../platform/storage/managed-storage';

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

  test('carries the response status on the thrown error so retry guards can classify it', () => {
    // Runtime routes never throw for an HTTP error — they resolve
    // `{ error, response }` and this unwrap throws. The status must survive:
    // useRuntimeProviders' 4xx retry guard reads it.
    try {
      unwrap({ error: { detail: 'Invalid or expired token' }, response: new Response(null, { status: 401 }) });
      expect.unreachable();
    } catch (error) {
      expect((error as { status?: number }).status).toBe(401);
    }
  });

  test('throws without a status when the response carried none (transport failure)', () => {
    try {
      unwrap({ error: { message: 'socket hung up' } });
      expect.unreachable();
    } catch (error) {
      expect((error as { status?: number }).status).toBeUndefined();
    }
  });
});

// ============================================================================
// canQueryRuntimeSession — rejects Kortix's own project-session UUIDs (which
// aren't real opencode session ids and would 404 the opencode API).
// ============================================================================

describe('canQueryRuntimeSession', () => {
  test('rejects null/undefined/empty', () => {
    expect(canQueryRuntimeSession(null)).toBe(false);
    expect(canQueryRuntimeSession(undefined)).toBe(false);
    expect(canQueryRuntimeSession('')).toBe(false);
  });

  test('rejects a v4 UUID (the Kortix project-session id shape)', () => {
    expect(canQueryRuntimeSession('550e8400-e29b-41d4-a716-446655440000')).toBe(false);
  });

  test('accepts a real opencode session id (ses_<...> shape)', () => {
    expect(canQueryRuntimeSession('ses_01hzxk3n8g8g8g8g8g8g8g8g')).toBe(true);
  });

  test('accepts an arbitrary non-UUID string', () => {
    expect(canQueryRuntimeSession('not-a-uuid-at-all')).toBe(true);
  });
});

// ============================================================================
// No runtime list is kept in localStorage.
//
// Sessions, agents, commands and providers each had a `kortix_cache_*:<scope>`
// family in localStorage, painted as `placeholderData`. They were a fifth copy
// of session state on the device, written on every list fetch. The web keeps
// two device caches now (`apps/web/src/lib/device-caches.ts`); the old keys
// are swept at boot there. `window`/`localStorage` don't exist in bun's
// default test environment, so both are stubbed.
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

/** As in a browser, `window.localStorage` and the bare global are one object. */
function stubBrowserStorage(): void {
  const storage = new MemoryStorage();
  (globalThis as GlobalWithDom).window = { localStorage: storage };
  (globalThis as GlobalWithDom).localStorage = storage;
}

describe('runtime list caches (localStorage stubbed)', () => {
  beforeEach(() => stubBrowserStorage());
  afterEach(() => {
    delete (globalThis as GlobalWithDom).window;
    delete (globalThis as GlobalWithDom).localStorage;
  });

  test('loading the hooks registers no localStorage cache family', () => {
    for (let n = 0; n < 6; n += 1) {
      localStorage.setItem(`kortix_cache_sessions:sbx_${n}`, JSON.stringify({ v: [], t: n }));
    }
    pruneAllRegisteredCaches();
    expect(localStorage.length).toBe(6);
  });

  test('clearProjectProviderCache stays callable and writes nothing', () => {
    expect(() => clearProjectProviderCache('p1')).not.toThrow();
    expect(localStorage.length).toBe(0);
  });
});

// ============================================================================
// asRuntimeList — the shape guard for runtime LIST
// endpoints.
//
// Incident (dev, 2026-08-23): `TypeError: t is not iterable` crashed the whole
// session view. `GET /command` is typed `Command[]`, but the value that reached
// the render was a truthy non-array, and every consumer iterates the list
// (`for…of` in detect-command, `.find`/`.some`/`.filter` in the composer). A
// list endpoint that answers with an unexpected shape must degrade to "no
// items", never crash the page.
// ============================================================================

describe('asRuntimeList', () => {
  test('passes an array through unchanged (same reference)', () => {
    const list = [{ name: 'build' }];
    expect(asRuntimeList(list)).toBe(list);
  });

  test('coerces every truthy non-array shape to an empty list', () => {
    expect(asRuntimeList({})).toEqual([]);
    expect(asRuntimeList({ commands: [{ name: 'build' }] })).toEqual([]);
    expect(asRuntimeList('not-a-list')).toEqual([]);
    expect(asRuntimeList(42)).toEqual([]);
    expect(asRuntimeList(true)).toEqual([]);
  });

  test('coerces undefined/null to an empty list', () => {
    expect(asRuntimeList(undefined)).toEqual([]);
    expect(asRuntimeList(null)).toEqual([]);
  });
});

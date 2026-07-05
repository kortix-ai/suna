import { test, expect, afterEach } from 'bun:test';
import {
  clearSessionRuntime,
  getSessionRuntime,
  setSessionRuntime,
} from './session-runtime-registry';

const PROJECT = 'proj-registry-test';
const SESSION = 'sess-registry-test';

afterEach(() => {
  clearSessionRuntime(PROJECT, SESSION);
});

test('getSessionRuntime returns undefined for a session no handle has resolved yet', () => {
  expect(getSessionRuntime(PROJECT, SESSION)).toBeUndefined();
});

test('setSessionRuntime records an entry retrievable by the same (projectId, sessionId)', () => {
  setSessionRuntime(PROJECT, SESSION, {
    opencodeSessionId: 'ocs-1',
    runtimeUrl: 'http://backend.test/p/sb-1/8000',
    sandboxId: 'sb-1',
  });

  expect(getSessionRuntime(PROJECT, SESSION)).toEqual({
    opencodeSessionId: 'ocs-1',
    runtimeUrl: 'http://backend.test/p/sb-1/8000',
    sandboxId: 'sb-1',
  });
});

test('entries for different session ids never collide', () => {
  setSessionRuntime(PROJECT, SESSION, {
    opencodeSessionId: 'ocs-1',
    runtimeUrl: 'http://backend.test/p/sb-1/8000',
    sandboxId: 'sb-1',
  });
  setSessionRuntime(PROJECT, 'sess-other', {
    opencodeSessionId: 'ocs-2',
    runtimeUrl: 'http://backend.test/p/sb-2/8000',
    sandboxId: 'sb-2',
  });

  expect(getSessionRuntime(PROJECT, SESSION)?.sandboxId).toBe('sb-1');
  expect(getSessionRuntime(PROJECT, 'sess-other')?.sandboxId).toBe('sb-2');

  clearSessionRuntime(PROJECT, 'sess-other');
});

test('entries for the same session id under different projects never collide', () => {
  setSessionRuntime('proj-a', SESSION, {
    opencodeSessionId: 'ocs-a',
    runtimeUrl: 'http://backend.test/p/sb-a/8000',
    sandboxId: 'sb-a',
  });
  setSessionRuntime('proj-b', SESSION, {
    opencodeSessionId: 'ocs-b',
    runtimeUrl: 'http://backend.test/p/sb-b/8000',
    sandboxId: 'sb-b',
  });

  expect(getSessionRuntime('proj-a', SESSION)?.sandboxId).toBe('sb-a');
  expect(getSessionRuntime('proj-b', SESSION)?.sandboxId).toBe('sb-b');

  clearSessionRuntime('proj-a', SESSION);
  clearSessionRuntime('proj-b', SESSION);
});

test('clearSessionRuntime removes the entry (restart/delete invalidation)', () => {
  setSessionRuntime(PROJECT, SESSION, {
    opencodeSessionId: 'ocs-1',
    runtimeUrl: 'http://backend.test/p/sb-1/8000',
    sandboxId: 'sb-1',
  });
  clearSessionRuntime(PROJECT, SESSION);

  expect(getSessionRuntime(PROJECT, SESSION)).toBeUndefined();
});

test('clearSessionRuntime on an unregistered session is a no-op (never throws)', () => {
  expect(() => clearSessionRuntime('proj-never', 'sess-never')).not.toThrow();
});

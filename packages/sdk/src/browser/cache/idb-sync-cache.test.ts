import { beforeEach, describe, expect, test } from 'bun:test';

import { configureKortix } from '../../core/http/config';
import { clearSessionIDBCache, saveSessionToIDB } from './idb-sync-cache';

describe('IndexedDB cache identity scope', () => {
  beforeEach(async () => {
    await clearSessionIDBCache();
  });

  test('resolves the current user once across repeated transcript writes', async () => {
    let identityReads = 0;
    configureKortix({
      backendUrl: 'https://api.example.test/v1',
      getToken: async () => null,
      getUserId: async () => {
        identityReads += 1;
        return 'user-1';
      },
    });

    await Promise.all([
      saveSessionToIDB('session-1', [], {}),
      saveSessionToIDB('session-1', [], {}),
      saveSessionToIDB('session-1', [], {}),
      saveSessionToIDB('session-1', [], {}),
    ]);

    expect(identityReads).toBe(1);
  });

  test('resolves the identity again after the session cache is cleared', async () => {
    let identityReads = 0;
    configureKortix({
      backendUrl: 'https://api.example.test/v1',
      getToken: async () => null,
      getUserId: async () => {
        identityReads += 1;
        return identityReads === 1 ? 'user-1' : 'user-2';
      },
    });

    await saveSessionToIDB('session-1', [], {});
    await clearSessionIDBCache();
    await saveSessionToIDB('session-2', [], {});

    expect(identityReads).toBe(2);
  });

  test('does not retain an unauthenticated scope', async () => {
    let identityReads = 0;
    configureKortix({
      backendUrl: 'https://api.example.test/v1',
      getToken: async () => null,
      getUserId: async () => {
        identityReads += 1;
        return identityReads === 1 ? null : 'user-1';
      },
    });

    await saveSessionToIDB('session-1', [], {});
    await saveSessionToIDB('session-1', [], {});

    expect(identityReads).toBe(2);
  });
});

import { beforeEach, expect, test } from 'bun:test';
import type { Message } from '@opencode-ai/sdk/v2/client';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { useOpenCodePendingStore } from '../browser/stores/opencode-pending-store';
import { useSessionWorkingStore } from '../browser/stores/session-working-store';
import { useSyncStore } from '../browser/stores/sync-store';
import { resetIdentityState } from './reset-identity-state';
import { useModelStore } from './use-model-store';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// When one user signs out, or a different user signs in (also from another
// tab, which swaps the identity without a reload), nothing the previous user
// saw or picked may survive in memory: transcripts, pending permission and
// question asks, turn receipts, and model picks. `resetIdentityState()` is the
// one call a host makes for that.

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  get length(): number {
    return this.map.size;
  }
}

const storage = new MemoryStorage();

beforeEach(() => {
  storage.clear();
  (globalThis as any).localStorage = storage;
  // The model store persists only where a window exists.
  (globalThis as any).window ??= globalThis;
});

function renderModelStore() {
  let api: ReturnType<typeof useModelStore>;
  function Probe() {
    api = useModelStore([]);
    return null;
  }
  let root: ReturnType<typeof create>;
  act(() => {
    root = create(React.createElement(Probe));
  });
  return {
    get api() {
      return api!;
    },
    unmount: () => act(() => root!.unmount()),
  };
}

test('resetIdentityState forgets the previous user\'s transcripts, asks, receipts and model picks', () => {
  // User A's state.
  useSyncStore.getState().upsertMessage('ses_A', {
    id: 'msg_A',
    sessionID: 'ses_A',
    role: 'user',
    time: { created: 1 },
  } as unknown as Message);
  useOpenCodePendingStore.getState().addPermission({ id: 'per_A', sessionID: 'ses_A' } as never);
  useOpenCodePendingStore.getState().addQuestion({ id: 'que_A', sessionID: 'ses_A', questions: [] } as never);
  useOpenCodePendingStore.getState().setAutoApproveAll('ses_A', true);
  useSessionWorkingStore.getState().noteAbortReceipt('kses_A', 1);

  const models = renderModelStore();
  act(() => {
    models.api.setSessionModel('ses_A', { providerID: 'kortix', modelID: 'model-of-user-a' });
  });
  expect(models.api.getSessionModel('ses_A')?.modelID).toBe('model-of-user-a');

  // Inside act: the reset notifies the mounted model-store subscriber.
  act(() => {
    resetIdentityState();
  });

  expect(useSyncStore.getState().messages.ses_A).toBeUndefined();
  const pending = useOpenCodePendingStore.getState();
  expect(pending.permissions).toEqual({});
  expect(pending.questions).toEqual({});
  expect(pending.autoApproveAllSessions).toEqual({});
  expect(useSessionWorkingStore.getState().aborts.kses_A).toBeUndefined();

  // The in-memory model store is empty, so user B's first pick cannot write
  // user A's picks back to storage.
  expect(models.api.getSessionModel('ses_A')).toBeUndefined();
  act(() => {
    models.api.setSessionModel('ses_B', { providerID: 'kortix', modelID: 'model-of-user-b' });
  });
  const persisted = storage.getItem('opencode-model-store-v1') ?? '';
  expect(persisted).toContain('model-of-user-b');
  expect(persisted).not.toContain('model-of-user-a');
  expect(persisted).not.toContain('ses_A');
  models.unmount();
});

test('resetIdentityState removes the persisted model store', () => {
  storage.setItem('opencode-model-store-v1', JSON.stringify({ user: [], recent: [], variant: {} }));
  resetIdentityState();
  expect(storage.getItem('opencode-model-store-v1')).toBeNull();
});

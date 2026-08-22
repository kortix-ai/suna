'use client';

import { createFilesStore, type FilesStoreApi } from '@/features/file-browser/store/files-store';

const MAX_SESSION_FILE_STORES = 20;
const stores = new Map<string, FilesStoreApi>();

export function getSessionFilesStore(sessionId: string): FilesStoreApi {
  const existing = stores.get(sessionId);
  if (existing) {
    stores.delete(sessionId);
    stores.set(sessionId, existing);
    return existing;
  }

  const store = createFilesStore();
  stores.set(sessionId, store);
  if (stores.size > MAX_SESSION_FILE_STORES) {
    const oldestSessionId = stores.keys().next().value;
    if (oldestSessionId) stores.delete(oldestSessionId);
  }
  return store;
}

export function resetSessionFilesStores(): void {
  stores.clear();
}

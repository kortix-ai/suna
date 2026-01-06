import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SpreadsheetComponent } from '@syncfusion/ej2-react-spreadsheet';
import { backendApi } from '@/lib/api-client';
import { getSandboxFileContent } from '@/lib/api/sandbox';

interface SyncState {
  status: 'idle' | 'syncing' | 'synced' | 'error' | 'offline' | 'conflict';
  lastSyncedAt: number | null;
  pendingChanges: boolean;
  errorMessage?: string;
  retryCount: number;
}

interface UseSpreadsheetSyncOptions {
  sandboxId: string | undefined;
  filePath: string | null;
  spreadsheetRef: React.RefObject<SpreadsheetComponent | null>;
  enabled?: boolean;
  debounceMs?: number;
  maxRetries?: number;
  pollIntervalMs?: number;
}

const DB_NAME = 'spreadsheet-sync-cache';
const STORE_NAME = 'files';
const DB_VERSION = 1;

async function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'key' });
      }
    };
  });
}

async function getCachedFile(key: string): Promise<{ blob: Blob; version: string; timestamp: number } | null> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(key);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result?.data || null);
    });
  } catch {
    return null;
  }
}

async function setCachedFile(key: string, blob: Blob, version: string): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.put({
        key,
        data: { blob, version, timestamp: Date.now() },
      });
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  } catch {
  }
}

async function clearCachedFile(key: string): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.delete(key);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  } catch {
  }
}

export function useSpreadsheetSync({
  sandboxId,
  filePath,
  spreadsheetRef,
  enabled = true,
  debounceMs = 2000,
  maxRetries = 3,
  pollIntervalMs = 30000,
}: UseSpreadsheetSyncOptions) {
  const [syncState, setSyncState] = useState<SyncState>({
    status: 'idle',
    lastSyncedAt: null,
    pendingChanges: false,
    retryCount: 0,
  });

  const [isLoading, setIsLoading] = useState(true);
  const [isComponentReady, setIsComponentReady] = useState(false);

  // Keep refs in sync with state for polling
  useEffect(() => {
    pendingChangesRef.current = syncState.pendingChanges;
  }, [syncState.pendingChanges]);

  useEffect(() => {
    isLoadingRef.current = isLoading;
  }, [isLoading]);

  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const hasInitiallyLoadedRef = useRef(false);
  const retryTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const currentVersionRef = useRef<string | null>(null);
  const isSavingRef = useRef(false);
  const pendingSaveRef = useRef(false);
  const lastKnownHashRef = useRef<string | null>(null);
  const isOnlineRef = useRef(navigator.onLine);
  const isEditingRef = useRef(false);
  const lastEditTimeRef = useRef<number>(0);
  const saveQueueRef = useRef<Blob | null>(null);
  const initialLoadDoneRef = useRef(false);
  const pendingChangesRef = useRef(false);
  const isLoadingRef = useRef(false);

  const cacheKey = sandboxId && filePath ? `${sandboxId}:${filePath}` : null;

  useEffect(() => {
    const handleOnline = () => {
      isOnlineRef.current = true;
      setSyncState(prev => {
        if (prev.status === 'offline' && prev.pendingChanges) {
          return { ...prev, status: 'idle' };
        }
        return prev.status === 'offline' ? { ...prev, status: 'idle' } : prev;
      });
      if (pendingSaveRef.current) {
        triggerBackgroundSave();
      }
    };

    const handleOffline = () => {
      isOnlineRef.current = false;
      setSyncState(prev => ({
        ...prev,
        status: 'offline',
      }));
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    };
  }, []);

  const generateHash = async (blob: Blob): Promise<string> => {
    const buffer = await blob.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  };

  const loadFromServer = useCallback(async (): Promise<boolean> => {
    if (!sandboxId || !filePath || !spreadsheetRef.current) {
      return false;
    }

    if (!initialLoadDoneRef.current) {
      setIsLoading(true);
    }

    try {
      const content = await getSandboxFileContent(sandboxId, filePath);

      const rawFileName = filePath.split('/').pop() || 'spreadsheet.xlsx';
      // Trim whitespace, newlines, and other control characters
      const fileName = rawFileName.trim().replace(/[\r\n]+/g, '').replace(/\s+$/g, '') || 'spreadsheet.xlsx';
      const fileExt = fileName.split('.').pop()?.toLowerCase();

      let mimeType = 'application/octet-stream';
      if (fileExt === 'xlsx') {
        mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      } else if (fileExt === 'xls') {
        mimeType = 'application/vnd.ms-excel';
      } else if (fileExt === 'csv') {
        mimeType = 'text/csv';
      }

      let fileBlob: Blob;
      if (content instanceof Blob) {
        fileBlob = new Blob([content], { type: mimeType });
      } else if (typeof content === 'string') {
        fileBlob = new Blob([content], { type: mimeType });
      } else {
        fileBlob = new Blob([JSON.stringify(content)], { type: mimeType });
      }

      const hash = await generateHash(fileBlob);
      lastKnownHashRef.current = hash;
      currentVersionRef.current = hash;

      if (cacheKey) {
        await setCachedFile(cacheKey, fileBlob, hash);
      }

      const file = new File([fileBlob], fileName, { type: mimeType });
      spreadsheetRef.current.open({ file });

      setSyncState({
        status: 'synced',
        lastSyncedAt: Date.now(),
        pendingChanges: false,
        retryCount: 0,
      });

      initialLoadDoneRef.current = true;
      return true;
    } catch (error: any) {
      console.error('[SpreadsheetSync] Load error:', error);

      if (!isOnlineRef.current && cacheKey) {
        const cached = await getCachedFile(cacheKey);
        if (cached) {
          const rawFileName = filePath.split('/').pop() || 'spreadsheet.xlsx';
          const fileName = rawFileName.trim().replace(/[\r\n]+/g, '').replace(/\s+$/g, '') || 'spreadsheet.xlsx';
          const file = new File([cached.blob], fileName, { type: cached.blob.type });
          spreadsheetRef.current.open({ file });
          currentVersionRef.current = cached.version;
          lastKnownHashRef.current = cached.version;

          setSyncState({
            status: 'offline',
            lastSyncedAt: cached.timestamp,
            pendingChanges: false,
            retryCount: 0,
          });

          setIsLoading(false);
          initialLoadDoneRef.current = true;
          return true;
        }
      }

      setSyncState(prev => ({
        ...prev,
        status: 'error',
        errorMessage: error?.message || 'Failed to load spreadsheet',
      }));

      setIsLoading(false);
      return false;
    }
  }, [sandboxId, filePath, spreadsheetRef, cacheKey]);

  const saveToServer = useCallback(async (blob: Blob): Promise<boolean> => {
    if (!sandboxId || !filePath) return false;

    try {
      const rawFileName = filePath.split('/').pop() || 'spreadsheet.xlsx';
      const fileName = rawFileName.trim().replace(/[\r\n]+/g, '').replace(/\s+$/g, '') || 'spreadsheet.xlsx';
      const uploadFormData = new FormData();
      uploadFormData.append('path', filePath);
      uploadFormData.append('file', blob, fileName);

      const response = await backendApi.uploadPut(`/sandboxes/${sandboxId}/files/binary`, uploadFormData, {
        showErrors: false,
        timeout: 60000,
      });

      if (response.error) {
        throw new Error(`Upload failed: ${response.error.message}`);
      }

      const hash = await generateHash(blob);
      lastKnownHashRef.current = hash;
      currentVersionRef.current = hash;

      if (cacheKey) {
        await setCachedFile(cacheKey, blob, hash);
      }

      return true;
    } catch (error: any) {
      throw error;
    }
  }, [sandboxId, filePath, cacheKey]);

  const triggerBackgroundSave = useCallback(() => {
    if (!spreadsheetRef.current || !sandboxId || !filePath || !enabled) {
      return;
    }

    if (isSavingRef.current) {
      pendingSaveRef.current = true;
      return;
    }

    isSavingRef.current = true;
    setSyncState(prev => ({ ...prev, status: 'syncing', pendingChanges: true }));

    const fileExt = filePath.split('.').pop()?.toLowerCase();
    const saveType = fileExt === 'csv' ? 'Csv' : 'Xlsx';
    const rawFileName = filePath.split('/').pop() || 'spreadsheet.xlsx';
    const fileName = rawFileName.trim().replace(/[\r\n]+/g, '').replace(/\s+$/g, '') || 'spreadsheet.xlsx';

    spreadsheetRef.current.save({
      saveType: saveType,
      fileName: fileName,
    });
  }, [spreadsheetRef, sandboxId, filePath, enabled]);

  const handleBeforeSave = useCallback((args: any) => {
    args.needBlobData = true;
    args.isFullPost = false;
  }, []);

  const handleSaveComplete = useCallback(async (args: any) => {
    const blob = args?.blobData;

    if (!blob) {
      isSavingRef.current = false;
      setSyncState(prev => ({
        ...prev,
        status: 'error',
        errorMessage: 'No data to save',
      }));
      return;
    }

    if (!isOnlineRef.current) {
      if (cacheKey) {
        const tempVersion = `offline-${Date.now()}`;
        await setCachedFile(cacheKey, blob, tempVersion);
      }
      pendingSaveRef.current = true;
      isSavingRef.current = false;
      setSyncState({
        status: 'offline',
        lastSyncedAt: null,
        pendingChanges: true,
        retryCount: 0,
      });
      return;
    }

    try {
      await saveToServer(blob);

      setSyncState({
        status: 'synced',
        lastSyncedAt: Date.now(),
        pendingChanges: false,
        retryCount: 0,
      });

      pendingSaveRef.current = false;
    } catch (error: any) {
      console.error('[SpreadsheetSync] Save error:', error);

      setSyncState(prev => {
        const newRetryCount = prev.retryCount + 1;

        if (newRetryCount < maxRetries) {
          const delay = Math.min(1000 * Math.pow(2, newRetryCount), 30000);
          retryTimeoutRef.current = setTimeout(() => {
            triggerBackgroundSave();
          }, delay);

          return {
            ...prev,
            status: 'syncing',
            retryCount: newRetryCount,
            pendingChanges: true,
          };
        }

        return {
          ...prev,
          status: 'error',
          errorMessage: error?.message || 'Save failed - changes saved locally',
          retryCount: newRetryCount,
          pendingChanges: true,
        };
      });

      if (cacheKey) {
        const tempVersion = `pending-${Date.now()}`;
        await setCachedFile(cacheKey, blob, tempVersion);
      }
    } finally {
      isSavingRef.current = false;

      if (pendingSaveRef.current && isOnlineRef.current) {
        pendingSaveRef.current = false;
        setTimeout(triggerBackgroundSave, 500);
      }
    }
  }, [cacheKey, saveToServer, maxRetries, triggerBackgroundSave]);

  const scheduleAutoSave = useCallback(() => {
    if (!enabled || !hasInitiallyLoadedRef.current) return;

    lastEditTimeRef.current = Date.now();
    
    setSyncState(prev => {
      if (prev.status === 'synced' || prev.status === 'idle') {
        return { ...prev, pendingChanges: true, status: 'idle' };
      }
      return { ...prev, pendingChanges: true };
    });

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    saveTimeoutRef.current = setTimeout(() => {
      if (Date.now() - lastEditTimeRef.current >= debounceMs - 100) {
        triggerBackgroundSave();
      }
    }, debounceMs);
  }, [enabled, debounceMs, triggerBackgroundSave]);

  const handleCellEdit = useCallback((args: any) => {
    isEditingRef.current = true;
  }, []);

  const handleCellSave = useCallback((args: any) => {
    isEditingRef.current = false;
    scheduleAutoSave();
  }, [scheduleAutoSave]);

  const SAVE_TRIGGERING_ACTIONS = useMemo(() => new Set([
    'cellSave',
    'cellDelete',
    'format',
    'cellFormat',
    'numberFormat',
    'wrap',
    'merge',
    'unmerge',
    'insertRow',
    'insertColumn',
    'deleteRow',
    'deleteColumn',
    'hideRow',
    'hideColumn',
    'showRow',
    'showColumn',
    'rowHeight',
    'columnWidth',
    'clear',
    'clearFormat',
    'paste',
    'undo',
    'redo',
    'sorting',
    'filtering',
    'addNote',
    'editNote',
    'deleteNote',
    'freezePanes',
    'unfreezePanes',
    'conditionalFormat',
    'validation',
    'removeValidation',
    'hyperlink',
    'removeHyperlink',
    'insertImage',
    'deleteImage',
    'insertChart',
    'deleteChart',
    'chartRefresh',
    'renameSheet',
    'insertSheet',
    'deleteSheet',
    'moveSheet',
    'duplicateSheet',
    'protectSheet',
    'unprotectSheet',
    'lockCells',
    'unlockCells',
  ]), []);

  const handleActionComplete = useCallback((args: any) => {
    const action = args?.action;
    if (action && SAVE_TRIGGERING_ACTIONS.has(action) && hasInitiallyLoadedRef.current) {
      scheduleAutoSave();
    }
  }, [scheduleAutoSave, SAVE_TRIGGERING_ACTIONS]);

  const handleOpenComplete = useCallback(() => {
    setIsLoading(false);
    hasInitiallyLoadedRef.current = true;
    setSyncState(prev => ({
      ...prev,
      status: isOnlineRef.current ? 'synced' : 'offline',
      lastSyncedAt: Date.now(),
    }));
  }, []);

  const handleOpenFailure = useCallback((args: any) => {
    console.error('[SpreadsheetSync] Open failure:', args);
    setIsLoading(false);
    setSyncState(prev => ({
      ...prev,
      status: 'error',
      errorMessage: 'Failed to open file',
    }));
  }, []);

  const handleCreated = useCallback(() => {
    setIsComponentReady(true);
  }, []);

  useEffect(() => {
    if (sandboxId && filePath && isComponentReady && enabled && !initialLoadDoneRef.current) {
      loadFromServer();
    }
  }, [sandboxId, filePath, isComponentReady, enabled]);

  useEffect(() => {
    if (!enabled || !sandboxId || !filePath || pollIntervalMs <= 0) {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
      return;
    }

    // Clear any existing interval
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
    }

    pollIntervalRef.current = setInterval(async () => {
      // Use refs to check current state without causing interval recreation
      if (!hasInitiallyLoadedRef.current || isSavingRef.current || !isOnlineRef.current || isLoadingRef.current || isEditingRef.current) {
        return;
      }

      if (pendingChangesRef.current) {
        return;
      }

      const timeSinceLastEdit = Date.now() - lastEditTimeRef.current;
      if (timeSinceLastEdit < 5000) { // Increased from 2000ms to 5000ms - don't poll right after edits
        return;
      }

      try {
        const content = await getSandboxFileContent(sandboxId, filePath);
        let blob: Blob;
        if (content instanceof Blob) {
          blob = content;
        } else if (typeof content === 'string') {
          blob = new Blob([content]);
        } else {
          blob = new Blob([JSON.stringify(content)]);
        }

        const hash = await generateHash(blob);

        if (lastKnownHashRef.current && hash !== lastKnownHashRef.current) {
          // Double-check state with refs before updating
          if (pendingChangesRef.current || isEditingRef.current) {
            setSyncState(prev => ({
              ...prev,
              status: 'conflict',
              errorMessage: 'File was modified externally',
            }));
          } else {
            console.log('[SpreadsheetSync] External changes detected, auto-refreshing...');
            lastKnownHashRef.current = hash;
            currentVersionRef.current = hash;
            
            if (cacheKey) {
              await setCachedFile(cacheKey, blob, hash);
            }
            
            const rawFileName = filePath.split('/').pop() || 'spreadsheet.xlsx';
            const fileName = rawFileName.trim().replace(/[\r\n]+/g, '').replace(/\s+$/g, '') || 'spreadsheet.xlsx';
            const fileExt = fileName.split('.').pop()?.toLowerCase();
            let mimeType = 'application/octet-stream';
            if (fileExt === 'xlsx') {
              mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
            } else if (fileExt === 'xls') {
              mimeType = 'application/vnd.ms-excel';
            } else if (fileExt === 'csv') {
              mimeType = 'text/csv';
            }
            
            const fileBlob = new Blob([blob], { type: mimeType });
            const file = new File([fileBlob], fileName, { type: mimeType });
            
            if (spreadsheetRef.current) {
              spreadsheetRef.current.open({ file });
            }
            
            setSyncState(prev => ({
              ...prev,
              status: 'synced',
              lastSyncedAt: Date.now(),
            }));
          }
        }
      } catch {}
    }, pollIntervalMs);

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, [enabled, sandboxId, filePath, pollIntervalMs, spreadsheetRef, cacheKey]); // Removed syncState.pendingChanges and isLoading from deps

  const forceRefresh = useCallback(async () => {
    if (cacheKey) {
      await clearCachedFile(cacheKey);
    }
    initialLoadDoneRef.current = false;
    hasInitiallyLoadedRef.current = false;
    setIsLoading(true);
    setSyncState(prev => ({ ...prev, pendingChanges: false, status: 'idle' }));
    return loadFromServer();
  }, [cacheKey, loadFromServer]);

  const forceSave = useCallback(() => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    triggerBackgroundSave();
  }, [triggerBackgroundSave]);

  const resolveConflict = useCallback(async (keepLocal: boolean) => {
    if (keepLocal) {
      forceSave();
    } else {
      await forceRefresh();
    }
  }, [forceSave, forceRefresh]);

  const memoizedHandlers = useMemo(() => ({
    handleCellEdit,
    handleCellSave,
    handleActionComplete,
    handleBeforeSave,
    handleSaveComplete,
    handleOpenComplete,
    handleOpenFailure,
    handleCreated,
  }), [handleCellEdit, handleCellSave, handleActionComplete, handleBeforeSave, handleSaveComplete, handleOpenComplete, handleOpenFailure, handleCreated]);

  const memoizedActions = useMemo(() => ({
    forceRefresh,
    forceSave,
    resolveConflict,
  }), [forceRefresh, forceSave, resolveConflict]);

  return {
    syncState,
    isLoading,
    isComponentReady,
    handlers: memoizedHandlers,
    actions: memoizedActions,
  };
}

'use client';

import { create } from 'zustand';

export interface OptimisticFile {
  id: string;
  file: File;
  name: string;
  size: number;
  type: string;
  localUrl: string;
  status: 'pending' | 'uploading' | 'ready' | 'error';
  threadId: string;
  projectId: string;
  error?: string;
}

interface OptimisticFilesState {
  files: OptimisticFile[];

  addFiles: (threadId: string, projectId: string, files: File[]) => OptimisticFile[];
  updateFileStatus: (fileId: string, status: OptimisticFile['status'], error?: string) => void;
  removeFile: (fileId: string) => void;
  getFilesForThread: (threadId: string) => OptimisticFile[];
  clearFilesForThread: (threadId: string) => void;
  clearAll: () => void;
}

export const useOptimisticFilesStore = create<OptimisticFilesState>((set, get) => ({
  files: [],

  addFiles: (threadId, projectId, filesToAdd) => {
    const newOptimisticFiles: OptimisticFile[] = filesToAdd.map((file) => ({
      id: crypto.randomUUID(),
      file,
      name: file.name,
      size: file.size,
      type: file.type || 'application/octet-stream',
      localUrl: URL.createObjectURL(file),
      status: 'pending' as const,
      threadId,
      projectId,
    }));

    set((state) => ({
      files: [...state.files, ...newOptimisticFiles],
    }));

    return newOptimisticFiles;
  },

  updateFileStatus: (fileId, status, error) => {
    set((state) => ({
      files: state.files.map((f) =>
        f.id === fileId ? { ...f, status, error } : f
      ),
    }));
  },

  removeFile: (fileId) => {
    const file = get().files.find((f) => f.id === fileId);
    if (file?.localUrl) {
      URL.revokeObjectURL(file.localUrl);
    }
    set((state) => ({
      files: state.files.filter((f) => f.id !== fileId),
    }));
  },

  getFilesForThread: (threadId) => {
    return get().files.filter((f) => f.threadId === threadId);
  },

  clearFilesForThread: (threadId) => {
    const filesToClear = get().files.filter((f) => f.threadId === threadId);
    filesToClear.forEach((f) => {
      if (f.localUrl) {
        URL.revokeObjectURL(f.localUrl);
      }
    });
    set((state) => ({
      files: state.files.filter((f) => f.threadId !== threadId),
    }));
  },

  clearAll: () => {
    get().files.forEach((f) => {
      if (f.localUrl) {
        URL.revokeObjectURL(f.localUrl);
      }
    });
    set({ files: [] });
  },
}));

export const selectFilesForThread = (threadId: string) => (state: OptimisticFilesState) =>
  state.files.filter((f) => f.threadId === threadId);

export const selectPendingFilesForThread = (threadId: string) => (state: OptimisticFilesState) =>
  state.files.filter((f) => f.threadId === threadId && f.status === 'pending');

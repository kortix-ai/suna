'use client';

import { create } from 'zustand';

export interface DriveUpload {
  id: string;
  file: File;
  /** Folder it lands in; `undefined` is the source's root. */
  targetPath?: string;
  status: 'queued' | 'uploading' | 'done' | 'error';
  /** Bytes sent so far. */
  sent?: number;
  error?: string;
  /** Sends this file again. Set by the explorer that started it. */
  retry?: () => void;
}

interface DriveUploadsState {
  uploads: DriveUpload[];
  add: (batch: DriveUpload[]) => void;
  patch: (id: string, next: Partial<DriveUpload>) => void;
  clear: () => void;
}

/**
 * Every upload of the open project, outside any one folder view: a batch keeps
 * running and reporting while the user moves to another folder or another
 * page, and the tray in the project shell (`DriveUploadTray`) shows it there.
 */
export const useDriveUploads = create<DriveUploadsState>((set) => ({
  uploads: [],
  // A finished earlier run makes way; one still running keeps its rows.
  add: (batch) =>
    set((s) => ({
      uploads: s.uploads.every((u) => u.status === 'done') ? batch : [...s.uploads, ...batch],
    })),
  patch: (id, next) =>
    set((s) => ({ uploads: s.uploads.map((u) => (u.id === id ? { ...u, ...next } : u)) })),
  clear: () => set({ uploads: [] }),
}));

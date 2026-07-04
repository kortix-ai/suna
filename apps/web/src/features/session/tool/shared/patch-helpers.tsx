'use client';

import { DiffView } from '@/components/diff/diff-view';

export interface PatchFileLite {
  filePath?: string;
  relativePath?: string;
  type?: 'add' | 'update' | 'delete' | 'move';
  patch?: string;
  diff?: string;
  before?: string;
  after?: string;
  additions?: number;
  deletions?: number;
  movePath?: string;
}

export const PATCH_TYPE_STYLE: Record<
  string,
  { label: string; tone: 'success' | 'warning' | 'destructive' | 'info' }
> = {
  add: { label: 'Add', tone: 'success' },
  update: { label: 'Edit', tone: 'warning' },
  delete: { label: 'Delete', tone: 'destructive' },
  move: { label: 'Move', tone: 'info' },
};

export function RawPatchDiffView({ patch }: { patch: string; filename: string }) {
  if (!patch) return null;
  return <DiffView patch={patch} layout="unified" hideFileHeader />;
}

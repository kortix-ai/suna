/**
 * apply_patch helpers.
 *
 * Mirrors apps/web `tool/shared/patch-helpers.tsx`: `PatchFileLite`,
 * `PATCH_TYPE_STYLE` (label + status tone per patch type), and
 * `RawPatchDiffView` — a unified patch string through the shared `DiffView`
 * (unified, no file header). `filename` picks the highlighting language.
 */

import { languageFromPath } from '@/lib/session/tool-part-accessors';
import { DiffView } from './inline-diff-view';

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

export const PATCH_TYPE_STYLE: Record<string, { label: string; tone: 'success' | 'warning' | 'destructive' | 'info' }> = {
  add: { label: 'Add', tone: 'success' },
  update: { label: 'Edit', tone: 'warning' },
  delete: { label: 'Delete', tone: 'destructive' },
  move: { label: 'Move', tone: 'info' },
};

export function RawPatchDiffView({ patch, filename }: { patch: string; filename: string }) {
  if (!patch) return null;
  return <DiffView patch={patch} language={languageFromPath(filename)} />;
}

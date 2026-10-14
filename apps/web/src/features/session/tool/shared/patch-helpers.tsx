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

/**
 * The files a patch in the `*** Begin Patch` format names (Codex `apply_patch`, OpenCode
 * `patchText`), each with the before/after text of its hunks, for a call whose harness sent
 * no `files` metadata. Hunks join without their gaps: the diff shows what changed, not where.
 */
export function patchFilesFromText(text: string): PatchFileLite[] {
  const files: Array<PatchFileLite & { before: string; after: string }> = [];
  let file: (typeof files)[number] | undefined;
  for (const line of text.split(/\r?\n/)) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    const move = /^\*\*\* Move to: (.+)$/.exec(line);
    if (header) {
      const type = header[1] === 'Add' ? 'add' : header[1] === 'Delete' ? 'delete' : 'update';
      file = { relativePath: header[2]!.trim(), type, before: '', after: '', additions: 0, deletions: 0 };
      files.push(file);
    } else if (move && file) {
      file.type = 'move';
      file.movePath = move[1]!.trim();
    } else if (line === '*** End Patch') {
      file = undefined;
    } else if (file && !line.startsWith('***') && !line.startsWith('@@')) {
      const body = line.slice(1) + '\n';
      if (line.startsWith('+')) file.additions! += 1;
      if (line.startsWith('-')) file.deletions! += 1;
      if (!line.startsWith('+')) file.before += body;
      if (!line.startsWith('-')) file.after += body;
    }
  }
  // A file with no hunk (a delete) has no diff to draw.
  return files.map((f) => (f.before || f.after ? f : { ...f, before: undefined, after: undefined }));
}

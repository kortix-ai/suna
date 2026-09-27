/**
 * Pure logic of the `apply_patch` tool row — a port of apps/web
 * `tool/tools/apply-patch-tool.tsx` (trigger words, per-file rows) plus the
 * web `Badge` tone variants it draws, expressed on mobile tokens.
 */

import { getDirectory, getFilename, patchVerb, type PatchVerb } from '@kortix/sdk';

/** apps/web `hardcodedUi.i18nComplete.text778ed69bedf7`. */
export const PATCH_TEXT = {
  preparingChanges: 'Preparing changes…',
} as const;

/** Web `PatchFileLite` (`tool/shared/patch-helpers.tsx`). */
export interface PatchFile {
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

export function patchFiles(raw: unknown): PatchFile[] {
  return Array.isArray(raw) ? (raw as PatchFile[]) : [];
}

export interface PatchTrigger {
  /** Live and no file has arrived: the row is one "Preparing changes…" shimmer and no body. */
  preparing: boolean;
  title: string;
  subtitle: string | undefined;
  icon: PatchVerb['icon'];
}

export function patchTrigger({
  files,
  status,
  running,
  isError,
}: {
  files: PatchFile[];
  status: string;
  running: boolean;
  isError: boolean;
}): PatchTrigger {
  const isStreaming = (status === 'pending' || status === 'running') && running;
  const verb = patchVerb(files.map((f) => f.type));
  const title = isError ? verb.failed : isStreaming ? verb.running : verb.verb;
  let subtitle: string | undefined;
  if (files.length === 1) {
    const f = files[0];
    subtitle = getFilename(f.relativePath || f.filePath || '') || undefined;
  } else if (files.length > 1) {
    subtitle = `${files.length} files`;
  }
  return { preparing: isStreaming && files.length === 0, title, subtitle, icon: verb.icon };
}

export function patchBodyKind({ isError, files }: { isError: boolean; files: PatchFile[] }): 'error' | 'files' | null {
  if (isError) return 'error';
  return files.length > 0 ? 'files' : null;
}

/** One file opens by default; several start closed. */
export function patchInitialExpanded(files: PatchFile[]): number | null {
  return files.length === 1 ? 0 : null;
}

export type PatchRowDiff = { kind: 'inline'; before: string; after: string } | { kind: 'patch'; patch: string } | null;

export interface PatchRow {
  key: string;
  relPath: string;
  name: string;
  dir: string | undefined;
  typeKey: 'add' | 'update' | 'delete' | 'move';
  /** Web: the row is a toggle (caret) when any diff source exists. */
  hasDiff: boolean;
  /** What the open row draws: both sides → inline diff, else a raw patch. */
  diff: PatchRowDiff;
}

export function patchRow(file: PatchFile): PatchRow {
  const relPath = file.relativePath || file.filePath || '';
  const typeKey = file.type || 'update';
  const hasDiff = file.before != null || file.after != null || !!file.patch || !!file.diff;
  const diff: PatchRowDiff =
    file.before != null && file.after != null
      ? { kind: 'inline', before: file.before, after: file.after }
      : file.patch || file.diff
        ? { kind: 'patch', patch: (file.patch || file.diff) as string }
        : null;
  return {
    key: `${typeKey}:${relPath}`,
    relPath,
    name: getFilename(relPath) || relPath,
    dir: getDirectory(relPath),
    typeKey,
    hasDiff,
    diff,
  };
}

// ─── Badge tones ─────────────────────────────────────────────────────────────

export type BadgeTone = 'success' | 'warning' | 'destructive' | 'info' | 'muted';

type ToneToken = 'success' | 'warning' | 'destructive' | 'mutedForeground' | 'muted';

/**
 * Web `Badge` tone variants → token names. Web: success/warning/destructive
 * are `bg-<tone>/10 text-<tone>`; `info` is `bg-neutral-500/10
 * text-neutral-700` (muted-foreground on mobile); `muted` is `bg-muted/50
 * text-muted-foreground`. The inset ring is the fill colour, so it adds no
 * visible edge and is not drawn. The component resolves the tokens with
 * `withAlpha` (this module stays free of the theme import graph).
 */
export function toneBadgeSpec(tone: BadgeTone): { text: ToneToken; fill: ToneToken; fillAlpha: number } {
  switch (tone) {
    case 'success':
    case 'warning':
    case 'destructive':
      return { text: tone, fill: tone, fillAlpha: 0.1 };
    case 'info':
      return { text: 'mutedForeground', fill: 'mutedForeground', fillAlpha: 0.1 };
    case 'muted':
      return { text: 'mutedForeground', fill: 'muted', fillAlpha: 0.5 };
  }
}

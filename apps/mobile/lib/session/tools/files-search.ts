/**
 * Pure logic of the `read`, `list`, `glob` and `grep` tool rows — a port of
 * the trigger and body branches apps/web `tool/tools/read-tool.tsx`,
 * `list-tool.tsx`, `glob-tool.tsx` and `grep-tool.tsx` take inline.
 */

import { filePhase, fileVerb, getDirectory, isErrorOutput, type ParsedReadOutput } from '@kortix/sdk';
import { parseFilePaths, parseGrepOutput, type GrepFileGroup } from '@/lib/session/tool-output-parsers';

/** apps/web en strings. */
export const SEARCH_TEXT = {
  /** `componentsSessionToolRenderers.line3534JsxAttrMessageDirectoryIsEmpty` */
  directoryEmpty: 'Directory is empty',
  /** `componentsSessionToolRenderers.line3420JsxAttrMessageNoMatchingFilesFound` */
  noMatchingFiles: 'No matching files found',
  /** `componentsSessionToolRenderers.line3485JsxAttrMessageNoMatchingResultsFound` */
  noMatchingResults: 'No matching results found',
  /** `i18nComplete.text9fc7f1166869` */
  searched: 'Searched',
  /** `i18nComplete.text0ed6af34915f` */
  noMatches: 'no matches',
  /** `componentsSessionToolRenderers.line2853JsxTextWaitingForFileContent` */
  waitingForFileContent: 'Waiting for file content...',
  everything: 'Everything',
} as const;

const fileCount = (n: number) => `${n} ${n === 1 ? 'file' : 'files'}`;

/** Results card, empty state, output fallback, or nothing — the order all three search rows share. */
export function searchBodyKind({
  hasResults,
  isNoResults,
  output,
}: {
  hasResults: boolean;
  isNoResults: boolean;
  output: string;
}): 'results' | 'empty' | 'fallback' | null {
  if (hasResults) return 'results';
  if (isNoResults) return 'empty';
  return output ? 'fallback' : null;
}

// ─── glob ────────────────────────────────────────────────────────────────────

/** Patterns that match everything, so naming them adds nothing the count doesn't say. */
export const CATCH_ALL_GLOBS = new Set(['*', '**', '*/*', '**/*', '**/**', '*.*']);

export function globTrigger({
  pattern: rawPattern,
  path: rawPath,
  output,
  status,
}: {
  pattern?: unknown;
  path?: unknown;
  output: string;
  status: string;
}): { label: string; isPathLike: boolean; badge: string | undefined; filePaths: string[] | null; isNoResults: boolean } {
  const searchPath = (rawPath as string | undefined)?.trim() || undefined;
  const pattern = (rawPattern as string | undefined)?.trim();
  const filePaths = parseFilePaths(output);
  const hasResults = !!filePaths && filePaths.length > 0;
  const isNoResults = !hasResults && status === 'completed' && !!output && !isErrorOutput(output);
  const isCatchAll = !pattern || CATCH_ALL_GLOBS.has(pattern);
  const label = (!isCatchAll ? pattern : searchPath) ?? SEARCH_TEXT.everything;
  return {
    label,
    isPathLike: label !== SEARCH_TEXT.everything,
    badge: hasResults ? fileCount(filePaths!.length) : isNoResults ? SEARCH_TEXT.noMatches : undefined,
    filePaths,
    isNoResults,
  };
}

// ─── list ────────────────────────────────────────────────────────────────────

export function listTrigger({
  path,
  output,
  status,
  running,
}: {
  path?: unknown;
  output: string;
  status: string;
  running: boolean;
}): {
  title: string;
  subtitle: string | undefined;
  args: string[] | undefined;
  filePaths: string[] | null;
  isNoResults: boolean;
} {
  const filePaths = parseFilePaths(output);
  const hasResults = !!filePaths && filePaths.length > 0;
  const errored = isErrorOutput(output);
  const isNoResults = !hasResults && status === 'completed' && !!output && !errored;
  return {
    title: fileVerb('list', filePhase(running, errored)),
    subtitle: getDirectory(path as string) || (path as string) || undefined,
    args: hasResults ? [fileCount(filePaths!.length)] : isNoResults ? ['empty'] : undefined,
    filePaths,
    isNoResults,
  };
}

// ─── grep ────────────────────────────────────────────────────────────────────

export function grepTrigger({
  path,
  pattern,
  include,
  output,
  status,
}: {
  path?: unknown;
  pattern?: unknown;
  include?: unknown;
  output: string;
  status: string;
}): {
  title: string;
  subtitle: string | undefined;
  args: string[];
  groups: GrepFileGroup[] | null;
  isNoResults: boolean;
} {
  const args: string[] = [];
  if (pattern) args.push('pattern=' + String(pattern));
  if (include) args.push('include=' + String(include));
  const result = parseGrepOutput(output);
  const isError = status === 'completed' && isErrorOutput(output);
  const isNoResults = !result && !isError && status === 'completed' && !!output;
  if (result) args.push(fileCount(result.groups.length));
  else if (isNoResults) args.push(SEARCH_TEXT.noMatches);
  return {
    title: SEARCH_TEXT.searched,
    subtitle: getDirectory(path as string) || undefined,
    args,
    groups: result?.groups ?? null,
    isNoResults,
  };
}

// ─── read ────────────────────────────────────────────────────────────────────

/** `metadata.loaded` — instruction files the read pulled in; completed calls only. */
export function readLoaded(status: string, metadata: Record<string, unknown>): string[] {
  if (status !== 'completed') return [];
  const val = metadata.loaded;
  if (!val || !Array.isArray(val)) return [];
  return val.filter((p): p is string => typeof p === 'string');
}

export function readBodyKind({
  parsed,
  isStalePending,
  output,
}: {
  parsed: ParsedReadOutput | null;
  isStalePending: boolean;
  output: string;
}): 'code' | 'directory' | 'stale' | 'error' | null {
  if (parsed?.type === 'file' && parsed.content) return 'code';
  if (parsed?.type === 'directory' && parsed.entries && parsed.entries.length > 0) return 'directory';
  if (isStalePending) return 'stale';
  if (isErrorOutput(output)) return 'error';
  return null;
}

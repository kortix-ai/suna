/**
 * Elevated system directories that appear in the file tree but are directories,
 * not files. GET /file/content?path=.opencode always returns 400 "Path is a
 * directory"; issuing that read as content is never correct, so callers must
 * never enable a content query for them (it was a recurring source of 400s in
 * the session page). Kept as a standalone pure module so it can be unit-tested
 * without importing the 'use client' hook and its React/store dependencies.
 */
const SYSTEM_DIRECTORIES = new Set(['.opencode', '.kortix', '.git']);

export function isSystemDirectoryPath(filePath: string | null): boolean {
  if (!filePath) return false;
  const normalized = filePath.replace(/^\/+/, '').replace(/\/+$/, '');
  return SYSTEM_DIRECTORIES.has(normalized);
}

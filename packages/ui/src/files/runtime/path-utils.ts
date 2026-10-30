/**
 * Pure path heuristics for the files feature. No I/O — safe to unit test.
 */

/**
 * Heuristic: does a path's basename have a real file extension?
 *
 * A "real" extension is a dot that is NOT the leading dot of a dotfile or
 * dot-directory. So `file.ts` and `.eslintrc.json` have extensions, but
 * dot-directories like `.opencode`, `.github`, `.kortix` — and extensionless
 * dotfiles like `.env` — do not. Those must still be probed (via listFiles)
 * for being a directory rather than blindly rendered as a file, otherwise a
 * dot-directory gets opened as a file and the server returns
 * "Path is a directory".
 */
export function hasFileExtension(path: string): boolean {
  const basename = path.split('/').pop() || '';
  // lastIndexOf('.') === 0 means the only dot is the leading one (dotfile/dir);
  // > 0 means there's a dot after the first char → a real extension.
  return basename.lastIndexOf('.') > 0;
}

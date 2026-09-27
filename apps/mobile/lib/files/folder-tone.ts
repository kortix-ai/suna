/**
 * folderTone — the colour of a folder's icon, from its name (Jay, 2026-09-22).
 *
 * One of the six brand accents (`THEME.accent`), chosen by a stable hash of
 * the name, so a folder keeps its colour across renders and screens and
 * sibling folders spread across the palette. Case and a leading dot are
 * ignored: `.docs`, `Docs` and `docs` share a tone. Pure: unit-tested.
 */

export type FolderTone = 'blue' | 'yellow' | 'orange' | 'green' | 'purple' | 'red';

export const FOLDER_TONES: readonly FolderTone[] = ['blue', 'yellow', 'orange', 'green', 'purple', 'red'];

export function folderTone(name: string): FolderTone {
  const key = name.replace(/^\.+/, '').toLowerCase();
  // FNV-1a, 32-bit: cheap and well spread for short strings.
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return FOLDER_TONES[hash % FOLDER_TONES.length];
}

/**
 * The Files page as one flat, virtualised list (COR-155). The page used to
 * render every folder and file of a folder in a ScrollView; a folder with
 * thousands of files mounted thousands of rows. It now renders a FlatList of
 * these items:
 *
 * - `title`: a section title ("Folders", "Files"), shown only when both kinds
 *   are present (the old `SettingsGroup title` rule).
 * - `row`: one list row, with its index in its section so it draws as a
 *   `SettingsGroupItem` (first / last corners).
 * - `tiles`: one grid line of up to `columns` tiles.
 *
 * Pure: no React, no React Native.
 */

export interface FilesListEntry {
  path: string;
  type: 'file' | 'directory';
}

export type FilesListItem<T extends FilesListEntry> =
  | { kind: 'title'; key: string; label: string; first: boolean }
  | { kind: 'row'; key: string; entry: T; index: number; count: number; first: boolean }
  | { kind: 'tiles'; key: string; entries: T[]; first: boolean };

/**
 * Items for `folders` then `files`. `first` marks the first item of a section
 * after the first section, so the list can put the section gap above it.
 */
export function buildFilesListItems<T extends FilesListEntry>(
  folders: readonly T[],
  files: readonly T[],
  mode: 'list' | 'grid',
  columns = 2,
): FilesListItem<T>[] {
  const items: FilesListItem<T>[] = [];
  const both = folders.length > 0 && files.length > 0;
  const sections: { id: 'folders' | 'files'; label: string; entries: readonly T[] }[] = [
    { id: 'folders', label: 'Folders', entries: folders },
    { id: 'files', label: 'Files', entries: files },
  ];
  let sectionIndex = 0;
  for (const section of sections) {
    if (section.entries.length === 0) continue;
    const gapAbove = sectionIndex > 0;
    sectionIndex += 1;
    let first = gapAbove;
    // Grid always titles its sections; list titles them only when both show.
    if (mode === 'grid' || both) {
      items.push({ kind: 'title', key: `title:${section.id}`, label: section.label, first });
      first = false;
    }
    if (mode === 'list') {
      section.entries.forEach((entry, index) => {
        items.push({
          kind: 'row',
          key: `${section.id}:${entry.path}`,
          entry,
          index,
          count: section.entries.length,
          first: index === 0 && first,
        });
      });
    } else {
      for (let i = 0; i < section.entries.length; i += columns) {
        const entries = section.entries.slice(i, i + columns);
        items.push({ kind: 'tiles', key: `${section.id}:${entries[0].path}`, entries, first: i === 0 && first });
      }
    }
  }
  return items;
}

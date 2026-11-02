// Who may read which path of the index, as plain rules over the folder
// grants (drives/folders.ts). Pure, so the rules are tested without a
// database; drives/search-index/search.ts builds the inputs.

import {
  type FolderAccess,
  type FolderGrant,
  type FolderSubject,
  folderAccess,
  grantReaches,
  maxFolderAccess,
  pathWithinFolder,
  personalFolderOf,
} from '../folders';

/** Who is searching, as the index needs it: a SQL superset and the exact per-path rule. */
export interface SearchReader {
  include: string[] | null;
  exclude: string[];
  access(path: string): FolderAccess;
}

/**
 * A person's reader. `include` is null for a project admin (they reach every
 * folder but the protected ones), else the folders their grants name.
 * `exclude` is each person's or private channel's folder they cannot read
 * and hold no grant inside. Both are only a narrowing: `access` decides.
 */
export function personReader(grants: readonly FolderGrant[], subject: FolderSubject): SearchReader {
  const access = (path: string) => folderAccess(path, grants, subject);
  const reached = grants.filter((g) => grantReaches(g, subject) && access(g.path) !== 'none').map((g) => g.path);
  const protectedRoots = new Set<string>(subject.privateChannelFolders ?? []);
  for (const g of grants) {
    const own = personalFolderOf(g.path);
    if (own) protectedRoots.add(own);
  }
  const exclude = [...protectedRoots].filter(
    (root) => access(root) === 'none' && !reached.some((p) => pathWithinFolder(p, root)),
  );
  return { include: subject.admin ? null : [...new Set(reached)], exclude, access };
}

/** A session's reader: the folders it may mount, each at its mount's access. */
export function sessionReader(mounts: ReadonlyArray<{ path: string; readOnly: boolean }>): SearchReader {
  return {
    include: [...new Set(mounts.map((m) => m.path))],
    exclude: [],
    access: (path) =>
      mounts.reduce<FolderAccess>(
        (best, m) => (pathWithinFolder(path, m.path) ? maxFolderAccess(best, m.readOnly ? 'read' : 'write') : best),
        'none',
      ),
  };
}

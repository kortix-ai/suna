/**
 * The Drive screen's model, as data only.
 *
 * Paths, places, rows, the breadcrumb and the web link are pure functions here,
 * so `drive-view.test.tsx` covers them with no renderer and no SDK.
 * `drive-screen.tsx` calls them with what the SDK returned.
 *
 * Paths are Drive paths with a leading slash (`/Users/ana/notes.md`), the form
 * every `@kortix/sdk` Drive function takes. The top of Drive is `/`.
 *
 * The places are the web's rail (`apps/web/src/features/drives/files-view.tsx`
 * `DriveRail`): My files, Shared with me, Team folders, and All files for
 * project admins. The TUI adds "This session": the folders the open session
 * mounts under `/drives`.
 */

import type { Drive, DriveConflict, DriveEntry, FolderAccess, SessionDrive } from '@kortix/sdk';

import { relativeAge } from '../../lib/relative-time.ts';
import { formatBytes } from '../files/index.ts';

/** The per-person tree. Its folders are reached as My files or Shared with me. */
export const PEOPLE_ROOT = '/Users';

/** `Users/ana/` or `/Users/ana` → `/Users/ana`. The top is `/`. */
export function normalizeDrivePath(path: string | null | undefined): string {
  const trimmed = (path ?? '').trim().replace(/^\/+|\/+$/g, '');
  return trimmed ? `/${trimmed}` : '/';
}

export function joinDrivePath(dir: string, name: string): string {
  const base = normalizeDrivePath(dir);
  const leaf = name.trim().replace(/^\/+|\/+$/g, '');
  return base === '/' ? `/${leaf}` : `${base}/${leaf}`;
}

/** The folder a path sits in. The parent of `/` is `/`. */
export function parentDrivePath(path: string): string {
  const abs = normalizeDrivePath(path);
  const cut = abs.lastIndexOf('/');
  return cut <= 0 ? '/' : abs.slice(0, cut);
}

export function baseName(path: string): string {
  const abs = normalizeDrivePath(path);
  return abs === '/' ? '/' : abs.slice(abs.lastIndexOf('/') + 1);
}

/** True when `path` is `root` or below it. Everything is below `/`. */
export function isUnder(path: string, root: string): boolean {
  const abs = normalizeDrivePath(path);
  const top = normalizeDrivePath(root);
  return top === '/' || abs === top || abs.startsWith(`${top}/`);
}

export type PlaceKind = 'mine' | 'shared' | 'team' | 'session' | 'all';

/** One place to start from: a rail row in the web app. */
export interface DrivePlace {
  /** `<kind>:<root>`. Unique across places. */
  id: string;
  kind: PlaceKind;
  label: string;
  /** The folder the place opens. Going up from here returns to Places. */
  root: string;
  /** Right-hand text: who sees it, the access, or the session mount path. */
  meta: string;
}

/** Group headings, in the order Places prints them. My files has none. */
export const SECTION_TITLE: Record<PlaceKind, string> = {
  mine: 'My files',
  shared: 'Shared with me',
  team: 'Team folders',
  session: 'This session',
  all: 'Admin',
};

const SECTION_ORDER: readonly PlaceKind[] = ['mine', 'shared', 'team', 'session', 'all'];

function accessWord(access: FolderAccess): string {
  if (access === 'manage') return 'manage';
  if (access === 'write') return 'can edit';
  if (access === 'read') return 'read only';
  return '';
}

export interface PlacesInput {
  drive: Pick<Drive, 'personalFolder' | 'sharedWithMe' | 'access'>;
  /** The listing of `/`, for the team folders. Undefined while it loads. */
  rootEntries?: readonly DriveEntry[];
  /** The open session's mounts. Empty without a session. */
  sessionMounts?: readonly SessionDrive[];
}

/**
 * Every place, in rail order.
 *
 * A team folder is a top-level folder the caller can open: one they only pass
 * through on the way to a share (`access: 'none'`) is not theirs, and
 * `/Users` is the per-person tree, not a team folder. Same filter as the web's
 * `useDriveLocation`.
 */
export function buildPlaces({
  drive,
  rootEntries = [],
  sessionMounts = [],
}: PlacesInput): DrivePlace[] {
  const places: DrivePlace[] = [];
  const personal = drive.personalFolder ? normalizeDrivePath(drive.personalFolder) : null;
  if (personal) {
    places.push({
      id: `mine:${personal}`,
      kind: 'mine',
      label: 'My files',
      root: personal,
      meta: 'only you',
    });
  }
  for (const shared of drive.sharedWithMe ?? []) {
    const root = normalizeDrivePath(shared.path);
    places.push({
      id: `shared:${root}`,
      kind: 'shared',
      label: baseName(root),
      root,
      meta: accessWord(shared.access),
    });
  }
  for (const entry of rootEntries) {
    const root = normalizeDrivePath(entry.path);
    if (entry.type !== 'dir' || entry.access === 'none' || isUnder(root, PEOPLE_ROOT)) continue;
    places.push({
      id: `team:${root}`,
      kind: 'team',
      label: entry.name || baseName(root),
      root,
      meta: accessWord(entry.access),
    });
  }
  for (const mount of sessionMounts) {
    const root = normalizeDrivePath(mount.subdir);
    places.push({
      id: `session:${mount.mountPath}`,
      kind: 'session',
      label: mount.name || baseName(root),
      root,
      meta: `${mount.mountPath}${mount.readOnly ? ' · read only' : ''}`,
    });
  }
  if (drive.access === 'manage') {
    places.push({ id: 'all:/', kind: 'all', label: 'All files', root: '/', meta: 'admins' });
  }
  return places;
}

/**
 * The place a path belongs to: the one with the longest root that holds it,
 * so a path in My files is My files and not All files. Null when no place
 * holds it (a non-admin outside every share).
 */
export function locatePlace(path: string, places: readonly DrivePlace[]): DrivePlace | null {
  let best: DrivePlace | null = null;
  for (const place of places) {
    if (!isUnder(path, place.root)) continue;
    if (!best || place.root.length > best.root.length) best = place;
  }
  return best;
}

/** `My files / Memory / 2026`. The place label stands for its root. */
export function crumbText(place: DrivePlace | null, path: string): string {
  if (!place) return 'Places';
  const below = normalizeDrivePath(path)
    .slice(place.root === '/' ? 0 : place.root.length)
    .split('/')
    .filter(Boolean);
  return [place.label, ...below].join(' / ');
}

/** What one list row is. `heading` and `note` rows take no cursor. */
export type DriveRowKind = 'heading' | 'note' | 'place' | 'dir' | 'file' | 'conflict';

export interface DriveRow {
  /** Unique in one list: the Drive path, the place id, or the conflict id. */
  id: string;
  kind: DriveRowKind;
  name: string;
  /** The Drive path the row stands for. A place's root; a conflict's copy. */
  path: string;
  /** Right-hand text. */
  meta: string;
  /** The caller may only read this entry. */
  readOnly?: boolean;
}

export function isSelectable(row: DriveRow): boolean {
  return row.kind !== 'heading' && row.kind !== 'note';
}

/** Places, grouped under their headings. Team folders always show, even empty. */
export function placeRows(places: readonly DrivePlace[], teamFoldersLoading = false): DriveRow[] {
  const rows: DriveRow[] = [];
  for (const kind of SECTION_ORDER) {
    const group = places.filter((place) => place.kind === kind);
    if (group.length === 0 && kind !== 'team') continue;
    if (kind !== 'mine') {
      rows.push({
        id: `heading:${kind}`,
        kind: 'heading',
        name: SECTION_TITLE[kind],
        path: '',
        meta: '',
      });
    }
    if (group.length === 0) {
      rows.push({
        id: `note:${kind}`,
        kind: 'note',
        name: teamFoldersLoading ? 'loading…' : 'No team folders yet.',
        path: '',
        meta: '',
      });
    }
    for (const place of group) {
      rows.push({
        id: place.id,
        kind: 'place',
        name: place.label,
        path: place.root,
        meta: place.meta,
      });
    }
  }
  return rows;
}

/**
 * `DriveEntry.mtime` in epoch ms. Storage reports it without a unit; a value
 * below 10^12 is read as seconds (10^12 ms is 2001, 10^12 s is year 33658).
 */
export function entryTimeMs(mtime: number): number {
  if (!Number.isFinite(mtime) || mtime <= 0) return Number.NaN;
  return mtime < 1e12 ? mtime * 1000 : mtime;
}

/**
 * One folder's entries as rows: folders first, then case-insensitive name.
 *
 * Symlinks are dropped and so is `/Users` at the top, both as the web does
 * (`drive-explorer-source.tsx` `useDriveFileList`): every person's folder is
 * reached as My files or Shared with me.
 */
export function entryRows(entries: readonly DriveEntry[], now: number): DriveRow[] {
  return entries
    .filter((entry) => entry.type !== 'symlink')
    .filter((entry) => normalizeDrivePath(entry.path) !== PEOPLE_ROOT)
    .map<DriveRow>((entry) => {
      const path = normalizeDrivePath(entry.path);
      const age = relativeAge(entryTimeMs(entry.mtime), now);
      const readOnly = entry.access === 'read';
      const parts =
        entry.type === 'dir'
          ? [entry.shared ? 'shared' : '', readOnly ? 'read only' : '']
          : [formatBytes(entry.size), age, readOnly ? 'read only' : ''];
      return {
        id: path,
        kind: entry.type === 'dir' ? 'dir' : 'file',
        name: entry.name || baseName(path),
        path,
        meta: parts.filter(Boolean).join(' · '),
        readOnly,
      };
    })
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
      const lower = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
      return lower !== 0 ? lower : a.name.localeCompare(b.name);
    });
}

export function conflictRows(conflicts: readonly DriveConflict[], now: number): DriveRow[] {
  return conflicts.map((conflict) => ({
    id: conflict.conflictId,
    kind: 'conflict' as const,
    name: normalizeDrivePath(conflict.path),
    path: normalizeDrivePath(conflict.path),
    meta: `copy of ${baseName(conflict.originalPath)} · ${relativeAge(Date.parse(conflict.detectedAt), now) || 'now'}`,
  }));
}

/** Keep the rows whose name contains `query`. Headings stay only with a hit. */
export function filterDriveRows(rows: readonly DriveRow[], query: string): DriveRow[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...rows];
  return rows.filter((row) => isSelectable(row) && row.name.toLowerCase().includes(needle));
}

/**
 * The web Drive page for a folder.
 *
 * `?path=` is the web's own encoding (`drive-path-param.ts`): the caller's own
 * folder is `~`, any other folder is its path without the leading slash, and
 * the top is no value. Slashes stay readable, as `driveUrlWithPath` leaves them.
 */
export function driveWebUrl(
  webBaseUrl: string,
  projectId: string,
  folder: string,
  personalFolder: string | null,
): string {
  const base = `${webBaseUrl.replace(/\/+$/, '')}/projects/${encodeURIComponent(projectId)}/drive`;
  const abs = normalizeDrivePath(folder);
  const personal = personalFolder ? normalizeDrivePath(personalFolder) : null;
  let param = '';
  if (abs !== '/') {
    param =
      personal && (abs === personal || abs.startsWith(`${personal}/`))
        ? `~${abs.slice(personal.length)}`
        : abs.slice(1);
  }
  if (!param) return base;
  const query = new URLSearchParams({ path: param })
    .toString()
    .replace(/%2F/gi, '/')
    .replace(/%7E/gi, '~');
  return `${base}?${query}`;
}

/** The web page where a project admin turns on Volumes. */
export function featureFlagsWebUrl(webBaseUrl: string, projectId: string): string {
  return `${webBaseUrl.replace(/\/+$/, '')}/projects/${encodeURIComponent(projectId)}/admin/feature-flags`;
}

/**
 * Where `m` sends a row. A bare name renames in place; a value with a `/` is
 * a Drive path. Null when the value is empty, `.`/`..`, or unchanged.
 */
export function moveTarget(from: string, input: string): string | null {
  const value = input.trim();
  if (!value) return null;
  const to = value.includes('/')
    ? normalizeDrivePath(value)
    : joinDrivePath(parentDrivePath(from), value);
  if (to.split('/').some((segment) => segment === '.' || segment === '..')) return null;
  if (to === normalizeDrivePath(from) || to === '/') return null;
  return to;
}

/** A new folder or file name: one segment, no `/`, not `.`/`..`. */
export function validName(input: string): string | null {
  const name = input.trim();
  if (!name || name === '.' || name === '..' || name.includes('/')) return null;
  return name;
}

/** `HTTP 403 · Forbidden`. The status leads when the SDK error carries one. */
export function errorText(error: unknown): string {
  const status = (error as { status?: unknown } | null)?.status;
  const message =
    error instanceof Error && error.message
      ? error.message
      : typeof error === 'string' && error
        ? error
        : 'Unknown error';
  return typeof status === 'number' && status > 0 ? `HTTP ${status} · ${message}` : message;
}

/** The HTTP status an SDK error carries, or null. */
export function errorStatus(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : null;
}

/**
 * A session's Drive mounts, read through the Drive API.
 *
 * A session mounts folders of the project's Drive at `/drives/<mount>` in its
 * box. The box daemon serves only `/workspace`, `/tmp`, `/home` and `/opt`
 * (`DEFAULT_ALLOWED_ROOTS` in `apps/kortix-sandbox-agent-server/src/routes/
 * workspace/files.ts`), and the SDK's `toDaemonPath` strips the leading slash
 * of any other path, so `files.read('/drives/me/a.md')` asks the daemon for
 * `/workspace/drives/me/a.md` and gets a 404. The same bytes are one Drive read
 * away: the session's mounts (`GET /projects/:p/sessions/:s/drives`) name the
 * drive and folder behind each mount path.
 *
 * This is the TUI port of the web's `packages/ui/src/internal/files/
 * session-drive-files.ts` (`sessionDriveMountPath`, `resolveSessionDriveFile`,
 * `blobToFileContent`). The TUI does not depend on `@kortix/ui`, and the SDK
 * does not export these yet, so the mapping is repeated here — the one place
 * in this app — and wraps the sandbox loaders without the view knowing.
 */

import { type SessionDrive, stripTrailingSlashes } from '@kortix/sdk';

import type { TreeNode } from './file-tree.ts';
import type { ReadResult } from './file-viewer.tsx';

/** Where every session mounts its Drive folders. */
export const DRIVES_ROOT = '/drives';

/** The subset of a mount the mapping reads. */
export type DriveMount = Pick<SessionDrive, 'driveId' | 'mountPath' | 'subdir'>;

/** A Drive file or folder: the drive and its path in that drive. */
export interface MountedDrivePath {
  driveId: string;
  /** `/Users/ana/notes.md`. The top of the drive is `/`. */
  path: string;
  /** The mount it resolved through, for mapping listed paths back. */
  mount: DriveMount;
}

/**
 * `/drives/me/a.md`, or the relative `drives/me/a.md` an agent writes, as the
 * absolute mount path. Anything else, and any path with a `.` or `..` segment,
 * is not under `/drives`: null.
 */
export function drivesMountPath(filePath: string | null | undefined): string | null {
  const raw = (filePath ?? '').trim();
  const abs =
    raw === DRIVES_ROOT || raw.startsWith(`${DRIVES_ROOT}/`)
      ? raw
      : raw.startsWith('drives/')
        ? `/${raw}`
        : null;
  if (!abs) return null;
  const segments = abs.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..')) return null;
  return `/${segments.join('/')}`;
}

/** The Drive path behind `filePath` in a session with these mounts, or null. */
export function resolveMountedPath(
  filePath: string | null | undefined,
  mounts: readonly DriveMount[],
): MountedDrivePath | null {
  const abs = drivesMountPath(filePath);
  if (!abs) return null;
  let best: DriveMount | null = null;
  for (const mount of mounts) {
    const root = stripTrailingSlashes(mount.mountPath);
    if (!root || (abs !== root && !abs.startsWith(`${root}/`))) continue;
    if (!best || root.length > stripTrailingSlashes(best.mountPath).length) best = mount;
  }
  if (!best) return null;
  const rest = abs.slice(stripTrailingSlashes(best.mountPath).length);
  const subdir = stripTrailingSlashes(best.subdir);
  return { driveId: best.driveId, path: `${subdir}${rest}` || '/', mount: best };
}

/**
 * The folders implied by mounts BELOW `dir`, one level down.
 *
 * `/drives` itself is not a Drive folder: it is the parent of every mount. A
 * mount may also sit two levels deep (`/drives/Company/Reports`), so
 * `/drives/Company` exists only as the way to it. These synthetic folders are
 * what a listing of `dir` shows for mounts under it.
 */
export function mountChildren(dir: string, mounts: readonly DriveMount[]): TreeNode[] {
  const base = stripTrailingSlashes(dir) || '/';
  const prefix = `${base}/`;
  const seen = new Map<string, TreeNode>();
  for (const mount of mounts) {
    const root = stripTrailingSlashes(mount.mountPath);
    if (!root.startsWith(prefix)) continue;
    const name = root.slice(prefix.length).split('/')[0];
    if (!name) continue;
    const path = `${prefix}${name}`;
    if (!seen.has(path)) seen.set(path, { name, path, type: 'directory', ignored: false });
  }
  return [...seen.values()];
}

/** The two Drive reads the wrapped loaders make. Injected so a test needs no SDK. */
export interface DriveReads {
  listFolder(
    driveId: string,
    path: string,
  ): Promise<{ entries: Array<{ path: string; name: string; type: 'file' | 'dir' | 'symlink' }> }>;
  readFile(driveId: string, path: string): Promise<Blob>;
}

export interface DirectoryLoaders {
  listDirectory(path: string): Promise<TreeNode[]>;
  readFile(path: string): Promise<ReadResult>;
}

/**
 * The sandbox loaders, with every path under `/drives` read through Drive.
 *
 * - Listing `root` (`/workspace`) adds one `/drives` folder when the session
 *   mounts anything, so the mounts are reachable from the tree.
 * - Listing a path under `/drives` merges the Drive folder behind it (when a
 *   mount covers it) with the synthetic folders of deeper mounts.
 * - Reading a path under a mount reads the Drive file. A path under `/drives`
 *   that no mount covers throws instead of asking the sandbox for a 404.
 * - Every other path goes to the sandbox, unchanged.
 */
export function withDriveMounts(
  base: DirectoryLoaders,
  mounts: readonly DriveMount[],
  drive: DriveReads,
  root: string,
): DirectoryLoaders {
  if (mounts.length === 0) return base;
  return {
    async listDirectory(path: string) {
      const abs = drivesMountPath(path);
      if (!abs) {
        const nodes = await base.listDirectory(path);
        if (path !== root || nodes.some((node) => node.path === DRIVES_ROOT)) return nodes;
        return [...nodes, { name: 'drives', path: DRIVES_ROOT, type: 'directory', ignored: false }];
      }
      const synthetic = mountChildren(abs, mounts);
      const target = resolveMountedPath(abs, mounts);
      if (!target) {
        if (synthetic.length === 0) throw new Error(`${abs} is not a mounted Drive folder.`);
        return synthetic;
      }
      const { entries } = await drive.listFolder(target.driveId, target.path);
      const mountRoot = stripTrailingSlashes(target.mount.mountPath);
      const subdir = stripTrailingSlashes(target.mount.subdir);
      const listed = entries
        .filter((entry) => entry.type !== 'symlink')
        .map<TreeNode>((entry) => {
          const drivePath = entry.path.startsWith('/') ? entry.path : `/${entry.path}`;
          const rest =
            subdir && drivePath.startsWith(subdir) ? drivePath.slice(subdir.length) : drivePath;
          return {
            name: entry.name || rest.slice(rest.lastIndexOf('/') + 1),
            path: `${mountRoot}${rest.startsWith('/') ? rest : `/${rest}`}`,
            type: entry.type === 'dir' ? 'directory' : 'file',
            ignored: false,
          };
        });
      const have = new Set(listed.map((node) => node.path));
      return [...listed, ...synthetic.filter((node) => !have.has(node.path))];
    },
    async readFile(path: string) {
      if (!drivesMountPath(path)) return base.readFile(path);
      const target = resolveMountedPath(path, mounts);
      if (!target) throw new Error(`${path} is not under a mounted Drive folder.`);
      return blobToReadResult(await drive.readFile(target.driveId, target.path));
    },
  };
}

/**
 * Bytes as the viewer's read shape: UTF-8 text when they decode as text,
 * base64 otherwise. `toViewerState` then applies the viewer's size and image
 * rules, exactly as for a sandbox read.
 */
export async function blobToReadResult(blob: Blob): Promise<ReadResult> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  try {
    return { type: 'text', content: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return {
      type: 'binary',
      content: Buffer.from(bytes).toString('base64'),
      encoding: 'base64',
      mimeType: blob.type && blob.type !== 'application/octet-stream' ? blob.type : undefined,
    };
  }
}

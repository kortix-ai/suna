// Small pure helpers shared by the Files routes, the session mounts and the
// conflict scanner. Who may do what lives in ./folders.ts.

/**
 * Platinum's per-sandbox volume mount cap when its limits cannot be read. The
 * live value comes from Platinum (see volumes.ts `sandboxMountLimit`); every
 * volume counts against it, folders and the session's own state volume alike.
 */
export const DEFAULT_SANDBOX_MOUNT_LIMIT = 8;

/** What a session tells people about folders that did not fit. */
export function skippedDrivesMessage(names: string[], slots: number): string {
  return (
    `${names.length === 1 ? 'A folder did' : `${names.length} folders did`} not fit in this session: ${names.join(', ')}. ` +
    `A session has room for ${slots} folder mounts. Share a folder above them instead, or remove a share, then restart the session.`
  );
}

/** The Platinum volume name for a drive: stable, unique, and a valid volume name. */
export function driveVolumeName(driveId: string): string {
  return `kd-${driveId.replace(/-/g, '').slice(0, 20)}`;
}

/**
 * A drive-relative path from user input: absolute, no `.`/`..`/empty
 * segments. Returns null when the input cannot be one.
 */
export function normalizeDrivePath(raw: string | undefined | null): string | null {
  const value = (raw ?? '/').trim() || '/';
  if (value.includes('\0') || value.includes('\\')) return null;
  const segments = value.split('/').filter((s) => s !== '');
  if (segments.some((s) => s === '.' || s === '..')) return null;
  return `/${segments.join('/')}`;
}

/** " (conflict 2026-10-01 1405)" or " (conflict 2026-10-01 1405 a3f9)" or with a trailing number. */
const CONFLICT_MARK = / \(conflict \d{4}-\d{2}-\d{2} \d{4}[^)/]*\)/;

/** The path a conflict copy was made from, or null when the path is not a conflict copy. */
export function conflictOriginal(path: string): string | null {
  const slash = path.lastIndexOf('/');
  const dir = path.slice(0, slash + 1);
  const base = path.slice(slash + 1);
  const match = CONFLICT_MARK.exec(base);
  if (!match) return null;
  return dir + base.slice(0, match.index) + base.slice(match.index + match[0].length);
}

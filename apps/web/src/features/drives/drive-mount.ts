import type { DriveRecord } from './drive-model';

/** Company drives mount at /drives/<slug>; mirrors the server's slug rule. */
export function driveSlug(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'drive';
}

/**
 * Where a session sees this drive. The API's `mountPath` wins; the fallback
 * covers the fixed v1 layout. A non-default personal drive is not mounted.
 */
export function driveMountPath(drive: DriveRecord): string | null {
  if (drive.kind === 'personal' && !drive.isDefault && !drive.shared) return null;
  if (drive.mountPath) return drive.mountPath;
  if (drive.kind === 'personal') return '/drives/me';
  if (drive.kind === 'agent') return '/drives/agent';
  return `/drives/${driveSlug(drive.name)}`;
}

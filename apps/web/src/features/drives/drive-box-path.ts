'use client';

import type { Drive } from '@kortix/sdk';

const within = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);

/**
 * Where sessions see a folder of the Drive: your own folder at ~/Desktop in
 * your sessions; an agent's Drive (`/Agents/<agent>`) at /drives/<agent> in
 * that agent's sessions. Null for any other folder: it mounts only where an
 * admin granted it to an agent, under a name the session's README gives.
 */
export function boxPathOf(path: string, personal: string | null): string | null {
  if (personal && within(path, personal)) return `~/Desktop${path.slice(personal.length)}`;
  const parts = path.split('/').filter(Boolean);
  if (parts.length >= 2 && parts[0] === 'Agents') return ['/drives', mountName(parts[1]!), ...parts.slice(2)].join('/');
  return null;
}

/** The mount name a session gives a folder, as the API's `folderMountName` makes it. */
function mountName(name: string): string {
  const slug = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  const base = slug || 'folder';
  return base === 'me' || base === 'readme-md' ? `${base}-folder` : base;
}

/** {@link boxPathOf} for this drive's caller. */
export function useBoxPaths(drive: Drive): (path: string) => string | null {
  return (path) => boxPathOf(path, drive.personalFolder);
}

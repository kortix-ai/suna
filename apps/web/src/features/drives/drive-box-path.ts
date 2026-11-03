'use client';

import type { Drive } from '@kortix/sdk';

const within = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);

/**
 * Where sessions see a folder of the Drive: your own folder at ~/Desktop in
 * your sessions. Null for any other folder: a shared Drive mounts only in the
 * sessions of the agents added to it, under the name their README gives.
 */
export function boxPathOf(path: string, personal: string | null): string | null {
  if (personal && within(path, personal)) return `~/Desktop${path.slice(personal.length)}`;
  return null;
}

/** {@link boxPathOf} for this drive's caller. */
export function useBoxPaths(drive: Drive): (path: string) => string | null {
  return (path) => boxPathOf(path, drive.personalFolder);
}

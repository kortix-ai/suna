'use client';

import type { AgentMountPlan, Drive } from '@kortix/sdk';
import { useProjectMounts } from '@kortix/sdk/react';

const within = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);

/**
 * Where sessions see a folder of the Drive: your own folder at ~/Desktop in
 * your sessions; anything else through the deepest folder every session of
 * the project mounts (`GET /drives/:id/mounts`), e.g. `/drives/company/Memory`.
 * Null when no session mounts it by default.
 */
export function boxPathOf(path: string, personal: string | null, plan: AgentMountPlan | undefined): string | null {
  if (personal && within(path, personal)) return `~/Desktop${path.slice(personal.length)}`;
  const mount = (plan?.mounts ?? [])
    .filter((m) => within(path, m.path))
    .sort((a, b) => b.path.length - a.path.length)[0];
  return mount ? `${mount.mountPath}${path.slice(mount.path.length)}` : null;
}

/** The project's mount plan, for {@link boxPathOf}. */
export function useBoxPaths(drive: Drive): (path: string) => string | null {
  const plan = useProjectMounts(drive.driveId);
  return (path) => boxPathOf(path, drive.personalFolder, plan.data);
}

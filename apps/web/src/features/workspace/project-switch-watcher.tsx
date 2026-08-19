'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';

import { projectIdFromPathname, useProjectSwitchStore } from '@/stores/project-switch-store';

/**
 * Ends a workspace switch. One instance, in the authenticated app shell.
 *
 * The workspace picker starts a switch and then closes — Radix unmounts the menu
 * on select — so the picker itself cannot be what ends one. That is exactly how
 * the switch used to get stranded: nothing outside the menu owned the end of it,
 * so `targetProjectId` stayed set and every re-open of the picker painted a
 * field of spinners you could not switch out of. This watcher sits above every
 * route, so it is still mounted while the navigation it watches happens.
 *
 * It ends a switch three ways, in order of how good the news is:
 * - `arrived`: the URL is inside the target workspace. Compare-and-clear, so a
 *   slow older switch never clears a newer rapid click's target.
 * - `diverted`: the URL moved somewhere else entirely — a different workspace, a
 *   settings page, `/auth` after an access bounce. The switch is over; it just
 *   did not go where it was aimed.
 * - timed out: the URL never moved at all — a `router.push` that never resolves.
 *   A backstop, not a normal path.
 */
const SWITCH_TIMEOUT_MS = 20_000;

export type ProjectSwitchOutcome = 'idle' | 'pending' | 'arrived' | 'diverted';

export function resolveProjectSwitchOutcome(args: {
  targetProjectId: string | null;
  pathname: string | null;
  pathnameAtBegin: string | null;
}): ProjectSwitchOutcome {
  const { targetProjectId, pathname, pathnameAtBegin } = args;
  if (!targetProjectId) return 'idle';
  if (projectIdFromPathname(pathname) === targetProjectId) return 'arrived';
  // Still on the page the switch started from: the navigation is in flight.
  if (pathname === pathnameAtBegin) return 'pending';
  return 'diverted';
}

export function ProjectSwitchWatcher() {
  const pathname = usePathname();
  const targetProjectId = useProjectSwitchStore((s) => s.targetProjectId);
  const completeSwitch = useProjectSwitchStore((s) => s.completeSwitch);
  const cancelSwitch = useProjectSwitchStore((s) => s.cancelSwitch);

  // The pathname the switch started from. Without it, the first render after
  // `beginSwitch` — still on the old workspace, because `router.push` has not
  // resolved yet — is indistinguishable from "the user ended up somewhere else",
  // and the switch would cancel itself before it ever left the page.
  const pathnameAtBegin = useRef<string | null>(null);

  useEffect(() => {
    if (!targetProjectId) {
      pathnameAtBegin.current = null;
      return;
    }
    if (pathnameAtBegin.current === null) pathnameAtBegin.current = pathname;

    const outcome = resolveProjectSwitchOutcome({
      targetProjectId,
      pathname,
      pathnameAtBegin: pathnameAtBegin.current,
    });
    if (outcome === 'arrived') {
      completeSwitch(targetProjectId);
      return;
    }
    if (outcome === 'diverted') {
      cancelSwitch();
      return;
    }
    const timer = setTimeout(cancelSwitch, SWITCH_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [targetProjectId, pathname, completeSwitch, cancelSwitch]);

  return null;
}

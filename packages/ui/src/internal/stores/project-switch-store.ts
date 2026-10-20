'use client';

import { create } from 'zustand';

/**
 * Tracks an in-flight switch between workspaces so the workspace picker can show
 * which row you committed to while the route is still loading.
 *
 * Three rules, all of them earned from the bug this file used to have — the
 * store had a `beginSwitch` and an `endSwitch`, and NOTHING in the app ever
 * called `endSwitch`. One switch left `targetProjectId` set forever, which the
 * picker read as "a switch is in flight" and painted as a spinner on every row
 * that was not the active one, each of them `disabled`. The menu became a
 * permanent spinner field you could not switch out of.
 *
 * 1. The pending state is per-row, never global. Loading is `target === row`
 *    (see {@link shouldShowProjectSwitchLoading}), so a stale target can only
 *    ever mark the ONE row it names — never the whole list.
 * 2. The pending state is derived against the active workspace, so it self-heals:
 *    once the URL is on the target, that row is the active row and stops
 *    loading, whether or not anything cleared the store.
 * 3. Something always clears it anyway — {@link ProjectSwitchWatcher}, mounted
 *    once in the authenticated app shell, completes on arrival and cancels a
 *    switch that never lands.
 *
 * Clearing is compare-and-clear so a slow older switch cannot clear the target
 * of a newer rapid click — the same shape `session-switch-store` uses.
 */
interface ProjectSwitchState {
  targetProjectId: string | null;
  beginSwitch: (projectId: string) => void;
  completeSwitch: (projectId: string) => void;
  cancelSwitch: () => void;
}

export const useProjectSwitchStore = create<ProjectSwitchState>((set) => ({
  targetProjectId: null,
  beginSwitch: (projectId) => set({ targetProjectId: projectId }),
  completeSwitch: (projectId) =>
    set((state) => (state.targetProjectId === projectId ? { targetProjectId: null } : state)),
  cancelSwitch: () => set({ targetProjectId: null }),
}));

/**
 * The workspace id a pathname is inside, or `null`. `/projects/<id>` and every
 * route below it (`/projects/<id>/sessions/<sid>`, `/files`, …) all count as
 * being in that workspace — arriving anywhere inside the target completes the
 * switch.
 */
export function projectIdFromPathname(pathname: string | null | undefined): string | null {
  if (!pathname) return null;
  const match = /^\/projects\/([^/?#]+)/.exec(pathname);
  const id = match?.[1];
  if (!id) return null;
  // `/projects/start` and `/projects/new` are pages, not workspaces.
  return id === 'start' || id === 'new' ? null : id;
}

/**
 * Whether one workspace row in the picker shows its pending spinner.
 *
 * Only the row you actually clicked, and only until the URL is on it. The old
 * condition was `switching && row !== active` — a global "something is
 * switching" AND-ed with "this is not where I am", which spins every other row
 * in the list and, because nothing ever cleared `switching`, spins them forever.
 */
export function shouldShowProjectSwitchLoading(
  targetProjectId: string | null,
  rowProjectId: string,
  activeProjectId: string | null,
): boolean {
  if (targetProjectId === null) return false;
  if (targetProjectId !== rowProjectId) return false;
  return targetProjectId !== activeProjectId;
}

'use client';

import {
  PROJECT_WIDE_SPACE,
  bindingSpace,
  groupBySpace,
  listSpaces,
  type ManifestSpace,
  type ResourceBinding,
  type SpaceGroup,
} from '@kortix/sdk';
import { useFeatureFlag } from '@kortix/sdk/react';

/**
 * Spaces are Work in progress. A space is a channel (`spaces:` in kortix.yaml,
 * `agents.<name>.space`, a resource's `space` binding), so the `project_channels`
 * flag gates them. Off (the default), no surface shows a space, a space
 * filter, a space column or "Move to space"; the bindings stay in the files.
 */
export const SPACES_FLAG = 'project_channels' as const;

/** True only while the project's `project_channels` flag is on. False while it loads. */
export function useSpacesEnabled(projectId: string | null | undefined): boolean {
  return useFeatureFlag(projectId, SPACES_FLAG).enabled === true;
}

type SpacesConfig = { agents?: ReadonlyArray<{ name: string; space?: string | null }>; spaces?: ManifestSpace[] };

/**
 * The spaces a list page (Artifacts, Goals) offers, its groups, and the space
 * of each item. Off: no spaces, and every item is project-wide, so the page
 * shows no filter, no space chip and no "Move to space".
 */
export function spaceScope<T>(
  items: readonly T[],
  config: SpacesConfig | null | undefined,
  enabled: boolean,
  bindingOf: (item: T) => ResourceBinding | null | undefined,
): { spaces: ManifestSpace[]; groups: Array<SpaceGroup<T>>; spaceOf: (item: T) => string } {
  const agents = config?.agents ?? [];
  const spaceOf = (item: T) => (enabled ? (bindingSpace(bindingOf(item), agents) ?? PROJECT_WIDE_SPACE) : PROJECT_WIDE_SPACE);
  return {
    spaces: enabled ? listSpaces(config) : [],
    groups: groupBySpace([...items], enabled ? config?.spaces : undefined, spaceOf),
    spaceOf,
  };
}

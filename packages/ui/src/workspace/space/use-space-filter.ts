'use client';

import { PROJECT_WIDE_SPACE, listSpaces } from '@kortix/sdk';
import { useProjectConfig } from '@kortix/sdk/react';

import { ALL_SPACES } from '../../customize/shared/catalog/catalog-space-tabs';
import { useActiveSpace } from '../../internal/stores/active-space-store';
import { useUiPathname, useUiRouter, useUiSearchParams } from '../../providers/ui-provider';

/**
 * The space a list page (Goals, Artifacts) filters to: the `?space=` param
 * (a space home's "View all" link), else the active space, else
 * `ALL_SPACES`. A value that names no space of the project (a removed space
 * still stored as active) is `ALL_SPACES`. `PROJECT_WIDE_SPACE` selects
 * the project-wide items. Choosing one makes it the active space and drops
 * the param, so the sidebar, the home and the page agree.
 */
export function useSpaceFilter(projectId: string): [string, (value: string) => void] {
  const [active, setActive] = useActiveSpace(projectId);
  const config = useProjectConfig(projectId);
  const searchParams = useUiSearchParams();
  const router = useUiRouter();
  const pathname = useUiPathname();
  const param = searchParams.get('space');
  const raw = param || active || ALL_SPACES;
  const known =
    raw === ALL_SPACES ||
    raw === PROJECT_WIDE_SPACE ||
    !config ||
    listSpaces(config).some((space) => space.name === raw);
  const value = known ? raw : ALL_SPACES;
  const onChange = (next: string) => {
    // Project-wide is a filter of this page, not a space to make active.
    setActive(next === ALL_SPACES || next === PROJECT_WIDE_SPACE ? null : next);
    if (next === PROJECT_WIDE_SPACE) router.replace(`${pathname}?space=${PROJECT_WIDE_SPACE}`);
    else if (param) router.replace(pathname);
  };
  return [value, onChange];
}

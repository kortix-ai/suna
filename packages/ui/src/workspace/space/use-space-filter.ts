'use client';

import { DEFAULT_PROJECT_DOMAIN, listSpaces } from '@kortix/sdk';
import { useProjectConfig } from '@kortix/sdk/react';

import { ALL_DOMAINS } from '../../customize/shared/catalog/domain-filter-tabs';
import { useActiveDomain } from '../../internal/stores/active-domain-store';
import { useUiPathname, useUiRouter, useUiSearchParams } from '../../providers/ui-provider';

/**
 * The space a list page (Goals, Artifacts) filters to: the `?space=` param
 * (a space home's "View all" link), else the active space, else
 * `ALL_DOMAINS`. A value that names no space of the project (a removed space
 * still stored as active) is `ALL_DOMAINS`. `DEFAULT_PROJECT_DOMAIN` selects
 * the project-wide items. Choosing one makes it the active space and drops
 * the param, so the sidebar, the home and the page agree.
 */
export function useSpaceFilter(projectId: string): [string, (value: string) => void] {
  const [active, setActive] = useActiveDomain(projectId);
  const config = useProjectConfig(projectId);
  const searchParams = useUiSearchParams();
  const router = useUiRouter();
  const pathname = useUiPathname();
  const param = searchParams.get('space');
  const raw = param || active || ALL_DOMAINS;
  const known =
    raw === ALL_DOMAINS ||
    raw === DEFAULT_PROJECT_DOMAIN ||
    !config ||
    listSpaces(config).some((space) => space.name === raw);
  const value = known ? raw : ALL_DOMAINS;
  const onChange = (next: string) => {
    // Project-wide is a filter of this page, not a space to make active.
    setActive(next === ALL_DOMAINS || next === DEFAULT_PROJECT_DOMAIN ? null : next);
    if (next === DEFAULT_PROJECT_DOMAIN) router.replace(`${pathname}?space=${DEFAULT_PROJECT_DOMAIN}`);
    else if (param) router.replace(pathname);
  };
  return [value, onChange];
}

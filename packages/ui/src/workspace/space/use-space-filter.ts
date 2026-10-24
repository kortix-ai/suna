'use client';

import { ALL_DOMAINS } from '../../customize/shared/catalog/domain-filter-tabs';
import { useActiveDomain } from '../../internal/stores/active-domain-store';
import { useUiPathname, useUiRouter, useUiSearchParams } from '../../providers/ui-provider';

/**
 * The space a list page (Goals, Artifacts) filters to: the `?space=` param
 * (a space home's "View all" link), else the active space, else
 * `ALL_DOMAINS`. Choosing one makes it the active space and drops the param,
 * so the sidebar, the home and the page agree.
 */
export function useSpaceFilter(projectId: string): [string, (value: string) => void] {
  const [active, setActive] = useActiveDomain(projectId);
  const searchParams = useUiSearchParams();
  const router = useUiRouter();
  const pathname = useUiPathname();
  const param = searchParams.get('space');
  const value = param || active || ALL_DOMAINS;
  const onChange = (next: string) => {
    setActive(next === ALL_DOMAINS ? null : next);
    if (param) router.replace(pathname);
  };
  return [value, onChange];
}

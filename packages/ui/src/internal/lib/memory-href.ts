'use client';

import type { ProjectMemoryLayerScope } from '@kortix/sdk';
import { useProjectSpaces } from '@kortix/sdk/react';
import { useCallback } from 'react';

import { uiRoutes } from '../../lib/routes';
import { useUiPathname, useUiSearchParams } from '../../providers/ui-provider';

/** A memory layer as a link target: its scope and its key (`company` or the space id). */
export interface MemoryLayerRef {
  scope: ProjectMemoryLayerScope;
  key: string;
}

/**
 * Where a memory page opens: its channel's or DM's Memory tab with `?page=`
 * (`&history=1` opens its History too). A channel or DM the reader is on keeps
 * its other params, so an open thread stays beside the tab. Null when the
 * layer has no page here yet (a Company page, or a space not loaded).
 */
export function useMemoryPageHref(
  projectId: string | null | undefined,
  enabled = true,
): (layer: MemoryLayerRef, pageId: string, options?: { history?: boolean }) => string | null {
  const pathname = useUiPathname();
  const searchParams = useUiSearchParams();
  const spaces = useProjectSpaces(projectId, { enabled }).data;
  return useCallback((layer, pageId, options) => {
    if (!projectId || layer.scope === 'company') return null;
    const space = spaces?.find((candidate) => candidate.space_id === layer.key);
    let path: string | null = null;
    if (space?.kind === 'channel' && space.slug) path = uiRoutes().channel(projectId, space.slug);
    else if (space?.kind === 'dm' && space.dm_agent_name) path = uiRoutes().dm(projectId, space.dm_agent_name);
    if (!path) return null;
    const here = pathname === path || !!pathname?.endsWith(path);
    const params = new URLSearchParams(here ? searchParams.toString() : '');
    params.set('tab', 'memory');
    params.set('page', pageId);
    if (options?.history) params.set('history', '1');
    else params.delete('history');
    return `${here ? pathname : path}?${params.toString()}`;
  }, [projectId, pathname, searchParams, spaces]);
}

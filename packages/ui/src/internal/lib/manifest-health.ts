'use client';

/**
 * The project's `manifest_health`, read from the `qk.project.detail(id)` query
 * the rest of Customize already shares: no second request. `undefined` while
 * the read is in flight, and from an API that does not serve the field yet.
 * The server reads and validates `kortix.yaml`; a client never parses it to
 * decide what state it is in.
 */

import { getProjectDetail, type ProjectManifestHealth } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';

export function useProjectManifestHealth(projectId: string): ProjectManifestHealth | undefined {
  return useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    select: (detail) => detail.config?.manifest_health,
    enabled: !!projectId,
    ...contract('config'),
  }).data;
}

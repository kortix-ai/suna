/**
 * Kortix workspace compatibility hooks.
 *
 * Thin wrapper over `@kortix/sdk/react` (`use-kortix-master.ts`): the
 * react-query layer (query keys, caching, invalidation) lives in the SDK now.
 * This file's only job is to inject web's actor identity — derived from
 * `useAuth()` — into the SDK hooks via the `KortixMasterIdentity` seam, and
 * to re-export under the same names so every existing importer of
 * `apps/web/src/hooks/kortix/use-kortix-projects` keeps working unchanged.
 */

import { useAuth } from '@/features/providers/auth-provider';
import {
  kortixKeys,
  useKortixProjects as useKortixProjectsSdk,
  useKortixProject as useKortixProjectSdk,
  useKortixProjectForSession as useKortixProjectForSessionSdk,
  useKortixProjectSessions as useKortixProjectSessionsSdk,
  useDeleteProject,
  usePatchProject,
  type KortixMasterIdentity,
  type KortixProjectQueryOptions,
  type KortixProject,
} from '@kortix/sdk/react';

// The request/response shape lives in the SDK now (`@kortix/sdk/react`);
// re-exported here for existing importers.
export type { KortixProject };
export { kortixKeys, useDeleteProject, usePatchProject };

function useProjectsIdentity(): KortixMasterIdentity {
  const { user, isLoading } = useAuth();
  return { userId: user?.id ?? null, handle: 'me', isLoading };
}

export function useKortixProjects(_args?: undefined, options: KortixProjectQueryOptions = {}) {
  const identity = useProjectsIdentity();
  return useKortixProjectsSdk(identity, _args, options);
}

export function useKortixProject(id: string) {
  const identity = useProjectsIdentity();
  return useKortixProjectSdk(identity, id);
}

export function useKortixProjectForSession(sessionId: string, options: KortixProjectQueryOptions = {}) {
  const identity = useProjectsIdentity();
  return useKortixProjectForSessionSdk(identity, sessionId, options);
}

/**
 * Fetch sessions linked to a specific project.
 * Returns Runtime session objects enriched with title, time, etc.
 */
export function useKortixProjectSessions(
  projectId: string,
  options: KortixProjectQueryOptions = {},
) {
  const identity = useProjectsIdentity();
  return useKortixProjectSessionsSdk(identity, projectId, options);
}

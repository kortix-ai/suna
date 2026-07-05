'use client';

/**
 * Kortix tasks — thin wrapper over `@kortix/sdk/react` (`use-kortix-master.ts`).
 * The react-query layer (query keys, polling, invalidation) and the pure
 * `normalizeTask` helper live in the SDK now — none of these hooks ever read
 * `useAuth()`, so there is no identity to inject here. This file exists only
 * so existing importers of `apps/web/src/hooks/kortix/use-kortix-tasks` keep
 * working unchanged.
 */

import {
  useKortixTasks,
  useKortixTask,
  useKortixTaskEvents,
  useKortixTaskStatus,
  useCreateKortixTask,
  useUpdateKortixTask,
  useStartKortixTask,
  useApproveKortixTask,
  useDeleteKortixTask,
  type KortixTaskStatus,
  type KortixTask,
  type KortixTaskEvent,
  type KortixTaskLiveStatus,
} from '@kortix/sdk/react';

// The request/response shapes live in the SDK now (`@kortix/sdk/react`);
// re-exported here for existing importers.
export type { KortixTaskStatus, KortixTask, KortixTaskEvent, KortixTaskLiveStatus };

export {
  useKortixTasks,
  useKortixTask,
  useKortixTaskEvents,
  useKortixTaskStatus,
  useCreateKortixTask,
  useUpdateKortixTask,
  useStartKortixTask,
  useApproveKortixTask,
  useDeleteKortixTask,
};

'use client';

import { useQuery } from '@tanstack/react-query';
import {
  type WorkspaceConfigSummary,
  type WorkspaceDetail,
  getWorkspaceDetail,
} from '../core/rest/workspaces-client';
import { contract } from './query-contracts';
import { qk } from './query-keys';

/**
 * Server-side workspace config — the single source of truth for everything a user
 * selects AROUND a session: agents, commands, skills, the default agent, and env
 * requirements. Fetched from the Kortix server (workspace detail), so it works
 * before any sandbox runtime exists. This is the canonical home for the
 * "capabilities, not runtime state" split — `useVisibleAgents({ workspaceId })`
 * and `useWorkspaceModels(workspaceId)` are the per-surface siblings.
 *
 * Reads `qk.workspace.detail(id)` via a `select` projection — the SAME entry
 * every other project-detail reader shares (Customize, the capability pages,
 * the project shell) — rather than its own key. It used to key on the
 * standalone `['project-config', id]`, so every one of THOSE readers issued
 * its own `getWorkspaceDetail` fetch even though the response was
 * byte-identical to the one already cached under `qk.workspace.detail(id)`.
 */
export function useWorkspaceConfig(
  workspaceId: string | null | undefined,
): WorkspaceConfigSummary | undefined {
  const { data } = useQuery({
    queryKey: qk.workspace.detail(workspaceId ?? ''),
    queryFn: () => getWorkspaceDetail(workspaceId as string),
    select: (detail: WorkspaceDetail) => detail.config,
    enabled: !!workspaceId,
    ...contract('config'),
    retry: false,
  });
  return data;
}

/** @deprecated Use `useWorkspaceConfig`. */
export const useProjectConfig = useWorkspaceConfig;

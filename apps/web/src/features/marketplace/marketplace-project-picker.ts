'use client';

import { useQuery } from '@tanstack/react-query';

import { useAuth } from '@/features/providers/auth-provider';
import { listProjectsForAccount } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';

/**
 * Shared "pick a project to add this item to" query, used by the one unified
 * `AddToProjectModal` (which also offers a "＋ New project" sentinel alongside
 * whatever this returns). Lists the caller's projects under one query key.
 *
 * Fetches with no account_id, so this is the ONE real reader of
 * `qk.projects.list()` — the API resolves that to the caller's primary
 * (earliest-joined) account. Every mutation that invalidates the shared
 * `['kx', 'projects']` prefix reaches this entry too, keeping it out of the
 * stale trap a private key would fall into.
 */
export function useProjectPicker({
  open,
  enabled = true,
}: {
  /** Only fetches while the owning modal is open. */
  open: boolean;
  /** Set false to skip the query entirely (e.g. a fixed-project modal that
   *  never shows a picker). */
  enabled?: boolean;
  /** Unused: callers own their selection state. */
  preferredProjectId?: string;
}) {
  const { user } = useAuth();

  const projectsQuery = useQuery({
    queryKey: qk.projects.list(),
    queryFn: () => listProjectsForAccount(),
    enabled: !!user && open && enabled,
    ...contract('inventory'),
  });
  const projects = projectsQuery.data ?? [];

  return { projects, projectsQuery };
}

'use client';

import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { useAuth } from '@/features/providers/auth-provider';
import { listProjectsForAccount } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';

/**
 * Shared "pick a project to add this item to" query + auto-select state. Lists
 * the caller's projects under one query key and auto-picks a sensible default
 * the first time the list loads.
 *
 * It used to live in `features/marketplace/marketplace-project-picker.ts`. The
 * marketplace was removed from the product; this hook is not a marketplace
 * concern — it answers "which of my projects am I acting on", which any
 * install/import surface asks. Kept as a leaf here rather than re-homed inside
 * whichever feature happens to call it first.
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
  preferredProjectId,
}: {
  /** Only fetches while the owning modal is open. */
  open: boolean;
  /** Set false to skip the query entirely (e.g. a fixed-project modal that
   *  never shows a picker). */
  enabled?: boolean;
  /** Auto-selected once the list loads, if it's one of the account's
   *  projects — e.g. the project you're already customizing, so re-merging
   *  into it is the default instead of an arbitrary first item. Falls back
   *  to `projects[0]` when unset or not in the list. */
  preferredProjectId?: string;
}) {
  const { user } = useAuth();
  const [pickedProjectId, setPickedProjectId] = useState('');

  const projectsQuery = useQuery({
    queryKey: qk.projects.list(),
    queryFn: () => listProjectsForAccount(),
    enabled: !!user && open && enabled,
    ...contract('inventory'),
  });
  const projects = projectsQuery.data ?? [];

  useEffect(() => {
    if (!open || pickedProjectId || projects.length === 0) return;
    const preferred =
      preferredProjectId && projects.some((p) => p.project_id === preferredProjectId)
        ? preferredProjectId
        : projects[0].project_id;
    setPickedProjectId(preferred);
  }, [open, projects, pickedProjectId, preferredProjectId]);

  return { projects, projectsQuery, pickedProjectId, setPickedProjectId };
}

'use client';

import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { useAuth } from '@/features/providers/auth-provider';
import { listProjectsForAccount } from '@kortix/sdk/projects-client';

/**
 * Shared "pick a project to add this item to" query + auto-select state, used
 * by the one unified `AddToProjectModal` (which also offers a "＋ New
 * project" sentinel alongside whatever this returns). Lists the caller's
 * projects under one query key and auto-picks a sensible default the first
 * time the list loads.
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
    queryKey: ['projects', 'all-for-marketplace'],
    queryFn: () => listProjectsForAccount(),
    enabled: !!user && open && enabled,
    staleTime: 30_000,
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

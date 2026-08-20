'use client';

// ProjectSelect — one `Select` over `listProjectsForAccount(accountId)`.
//
// Replaces the four hand-rolled project `Select`s: `AttachToProjectDialog`
// (whose three distinct empty texts are ported here verbatim),
// `GrantAgentAccessDialog` step 1, `InviteMemberModal`'s project-access
// rows, `CreateAssignmentDialog`'s two project pickers, and the Audit
// tab's project filter.

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { usePermissions } from '@/lib/use-permission';
import { listProjectsForAccount, type KortixProject } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

export interface ProjectSelectEmptyText {
  /** The account has no projects at all. */
  none?: string;
  /** Projects exist and pass `filter`, but every one is in `excludeIds`. */
  allExcluded?: string;
  /** Projects exist but none passes `filter` (e.g. no Manager access). */
  noneEligible?: string;
}

const DEFAULT_EMPTY_TEXT: Required<ProjectSelectEmptyText> = {
  none: 'No projects in this account yet.',
  allExcluded: 'Already attached to every project you can manage.',
  noneEligible: 'You need Manager access on a project to attach a group to it.',
};

/** Sentinel for the optional "every project" row — never a real project id. */
export const PROJECT_SELECT_ALL = '__all__';

export interface ProjectSelectProps {
  accountId: string;
  /** `''` for nothing chosen, or `PROJECT_SELECT_ALL` with `allOptionLabel`. */
  value: string;
  onChange: (projectId: string) => void;
  /** Narrow the candidate list by a project property. For "which projects may I
   *  do X on?" use `requireAction` — a role label on the row cannot answer that. */
  filter?: (project: KortixProject) => boolean;
  /**
   * Keep only the projects on which the caller holds this permission leaf.
   *
   * ONE batched probe covers every candidate: `probeEffectivePermissions` takes
   * a per-probe target, so N projects cost one request, not N. Candidates stay
   * hidden until the probe answers — a picker that briefly offers a project the
   * caller cannot act on produces a 403 on submit.
   */
  requireAction?: string;
  /** Hide these ids on top of `filter` — projects already attached. */
  excludeIds?: string[] | Set<string>;
  /** Adds a leading "every project" row carrying `PROJECT_SELECT_ALL`. */
  allOptionLabel?: string;
  disabled?: boolean;
  placeholder?: string;
  emptyText?: ProjectSelectEmptyText;
  /** Defer the fetch until a dialog is actually open. */
  enabled?: boolean;
  id?: string;
  className?: string;
}

export function ProjectSelect({
  accountId,
  value,
  onChange,
  filter,
  excludeIds,
  allOptionLabel,
  disabled,
  placeholder = 'Choose a project',
  emptyText,
  enabled = true,
  requireAction,
  id,
  className,
}: ProjectSelectProps) {
  const projectsQuery = useQuery({
    queryKey: qk.projects.list(accountId),
    queryFn: () => listProjectsForAccount(accountId),
    enabled: enabled && !!accountId,
    ...contract('inventory'),
  });

  const all = useMemo(() => projectsQuery.data ?? [], [projectsQuery.data]);

  // One batch probe over every candidate project. `probes` is empty (and the
  // query disabled) when no `requireAction` was asked for.
  const probes = useMemo(
    () =>
      requireAction
        ? all.map((p) => ({
            action: requireAction,
            resourceType: 'project' as const,
            resourceId: p.project_id,
          }))
        : [],
    [all, requireAction],
  );
  const verdicts = usePermissions(accountId, probes);
  const permitted = useMemo(() => {
    if (!requireAction) return all;
    return all.filter((_, i) => verdicts[i]?.allowed === true);
  }, [all, requireAction, verdicts]);

  const eligible = useMemo(
    () => (filter ? permitted.filter(filter) : permitted),
    [permitted, filter],
  );
  const excludeSet = useMemo(() => (excludeIds ? new Set(excludeIds) : null), [excludeIds]);
  const candidates = useMemo(
    () =>
      [...(excludeSet ? eligible.filter((p) => !excludeSet.has(p.project_id)) : eligible)].sort(
        (a, b) => a.name.localeCompare(b.name),
      ),
    [eligible, excludeSet],
  );

  if (projectsQuery.isLoading) {
    return <Skeleton className={className ?? 'h-9 w-full rounded-lg'} />;
  }

  if (candidates.length === 0 && !allOptionLabel) {
    const copy = { ...DEFAULT_EMPTY_TEXT, ...emptyText };
    const message =
      all.length === 0 ? copy.none : eligible.length === 0 ? copy.noneEligible : copy.allExcluded;
    return (
      <p className="bg-popover text-muted-foreground rounded-md border px-3 py-2.5 text-xs">
        {message}
      </p>
    );
  }

  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger id={id} className={className}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {allOptionLabel ? <SelectItem value={PROJECT_SELECT_ALL}>{allOptionLabel}</SelectItem> : null}
        {candidates.map((project) => (
          <SelectItem key={project.project_id} value={project.project_id}>
            {project.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

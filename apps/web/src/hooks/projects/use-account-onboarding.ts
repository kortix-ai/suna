'use client';

/**
 * useAccountOnboarding — derives the new-account "get started" checklist.
 *
 * The account-level sibling of {@link useProjectSetup}. It answers "is this
 * account up and running yet?" from cheap, already-cached data:
 *
 *   1. Create your first project   (account has ≥ 1 project)
 *   2. Run your first session      (the most-recent project has ≥ 1 session)
 *   3. Invite your team            (account has > 1 member) — optional
 *
 * Completion is derived from real data, so it's always accurate and needs no
 * separate "dismissed/seen" flag to stay correct. Steps 2–3 unlock once a
 * project exists. The hook is safe to call with a null accountId (returns an
 * empty, not-loading state).
 */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FolderPlus, SquarePen, Users, type LucideIcon } from 'lucide-react';

import {
  getAccount,
  listProjectsForAccount,
  listProjectSessions,
} from '@/lib/projects-client';

export type AccountOnboardingStepId = 'project' | 'session' | 'team';

export interface AccountOnboardingStep {
  id: AccountOnboardingStepId;
  title: string;
  description: string;
  done: boolean;
  /** Recommended-but-not-required: shown, badged, excluded from completion. */
  optional: boolean;
  /** Not actionable until a prior essential step is done. */
  locked: boolean;
  icon: LucideIcon;
  cta: string;
  /** Docs page for the "Learn more" affordance. */
  learnHref: string;
}

export interface AccountOnboardingState {
  steps: AccountOnboardingStep[];
  /** Essential (non-optional) steps only. */
  requiredTotal: number;
  requiredDone: number;
  /** 0–100 across essential steps. */
  percent: number;
  isComplete: boolean;
  isLoading: boolean;
  /** Most-recently-updated project — used to deep-link the "session" step. */
  primaryProjectId: string | null;
}

const SHARED = { staleTime: 60_000, refetchOnWindowFocus: false } as const;

export function useAccountOnboarding(
  accountId: string | null | undefined,
): AccountOnboardingState {
  const enabled = !!accountId;

  const account = useQuery({
    queryKey: ['account-detail', accountId],
    queryFn: () => getAccount(accountId as string),
    enabled,
    ...SHARED,
  });

  // Shares the cache key the projects page already populates.
  const projects = useQuery({
    queryKey: ['projects', accountId],
    queryFn: () => listProjectsForAccount(accountId || undefined),
    enabled,
    ...SHARED,
  });

  const primaryProjectId = useMemo(() => {
    const items = projects.data ?? [];
    if (!items.length) return null;
    return [...items].sort(
      (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
    )[0].project_id;
  }, [projects.data]);

  const sessions = useQuery({
    queryKey: ['project-sessions', primaryProjectId],
    queryFn: () => listProjectSessions(primaryProjectId as string),
    enabled: enabled && !!primaryProjectId,
    ...SHARED,
  });

  const isLoading = enabled && (account.isLoading || projects.isLoading);

  return useMemo<AccountOnboardingState>(() => {
    const projectCount = account.data?.project_count ?? projects.data?.length ?? 0;
    const memberCount = account.data?.member_count ?? 0;
    const hasProject = projectCount > 0;
    const sessionDone = hasProject && (sessions.data?.length ?? 0) > 0;

    const steps: AccountOnboardingStep[] = [
      {
        id: 'project',
        title: 'Create your first project',
        description: 'A dedicated space for one company, product, or idea.',
        done: hasProject,
        optional: false,
        locked: false,
        icon: FolderPlus,
        cta: 'New project',
        learnHref: '/docs/concepts/projects',
      },
      {
        id: 'session',
        title: 'Run your first session',
        description:
          'Describe a task; your agent does it and proposes the result for your review.',
        done: sessionDone,
        optional: false,
        locked: !hasProject,
        icon: SquarePen,
        cta: 'Open project',
        learnHref: '/docs/quickstart',
      },
      {
        id: 'team',
        title: 'Invite your team',
        description: 'Add teammates so everyone can run and review work together.',
        done: memberCount > 1,
        optional: true,
        locked: false,
        icon: Users,
        cta: 'Invite',
        learnHref: '/docs/concepts/accounts',
      },
    ];

    const required = steps.filter((s) => !s.optional);
    const requiredDone = required.filter((s) => s.done).length;
    const requiredTotal = required.length;
    const percent =
      requiredTotal === 0 ? 100 : Math.round((requiredDone / requiredTotal) * 100);

    return {
      steps,
      requiredTotal,
      requiredDone,
      percent,
      isComplete: !isLoading && requiredDone === requiredTotal,
      isLoading,
      primaryProjectId,
    };
  }, [account.data, projects.data, sessions.data, primaryProjectId, isLoading]);
}

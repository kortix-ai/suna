'use client';

/**
 * useProjectSetup — derives a project's "are you set up yet?" checklist.
 *
 * Aggregates the same per-project queries the Customize surfaces already use
 * (reusing their query keys so the cache is shared, not duplicated) and folds
 * them into an ordered list of setup steps with a single completion signal.
 * Both the sidebar widget and the index-page card read from this one hook so
 * they can never disagree about what "done" means.
 *
 * Steps are scoped to USER-DRIVEN setup — things only the user can do that
 * meaningfully change project capability. We deliberately exclude:
 *   • "Connect a repository" — every project has one before this even runs.
 *   • "Set up your agent" — starter templates ship with default agents and
 *     skills, so the count is misleading. The deeper "build your own agents"
 *     loop lives in the wizard's informational closing step instead.
 *
 * Essential steps (drive the headline progress + the auto-hide):
 *   1. Required secrets filled in   (only shown when the manifest declares any)
 *   2. Connect at least one integration
 *   3. First session run
 *
 * Recommended steps (listed, badged "Optional", never block completion):
 *   • Invite your team
 */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  KeyRound,
  Plug,
  SquarePen,
  Users,
  type LucideIcon,
} from 'lucide-react';

import {
  getProjectDetail,
  listConnectors,
  listProjectAccess,
  listProjectSecrets,
  listProjectSessions,
} from '@/lib/projects-client';

export type ProjectSetupStepId =
  | 'secrets'
  | 'session'
  | 'connector'
  | 'team';

export interface ProjectSetupStep {
  id: ProjectSetupStepId;
  title: string;
  description: string;
  done: boolean;
  /** Recommended-but-not-required: shown, badged, excluded from completion. */
  optional: boolean;
  icon: LucideIcon;
  /** Customize surface that completes this step; null = handled by the caller. */
  href: string | null;
  cta: string;
  /** Docs page for the "Learn more" affordance. */
  learnHref: string;
}

export interface ProjectSetupState {
  steps: ProjectSetupStep[];
  /** Essential (non-optional) steps only. */
  requiredTotal: number;
  requiredDone: number;
  /** 0–100 across essential steps. */
  percent: number;
  /** Every essential step satisfied. */
  isComplete: boolean;
  /** First load still in flight — render nothing rather than a wrong state. */
  isLoading: boolean;
}

const SHARED = { staleTime: 60_000, refetchOnWindowFocus: false } as const;

export function useProjectSetup(projectId: string): ProjectSetupState {
  const enabled = !!projectId;

  const detail = useQuery({
    queryKey: ['project-detail', projectId],
    queryFn: () => getProjectDetail(projectId),
    enabled,
    ...SHARED,
  });
  const secrets = useQuery({
    queryKey: ['project-secrets', projectId],
    queryFn: () => listProjectSecrets(projectId),
    enabled,
    ...SHARED,
  });
  const access = useQuery({
    queryKey: ['project-access', projectId],
    queryFn: () => listProjectAccess(projectId),
    enabled,
    ...SHARED,
  });
  const connectors = useQuery({
    queryKey: ['project-connectors', projectId],
    queryFn: () => listConnectors(projectId),
    enabled,
    ...SHARED,
  });
  const sessions = useQuery({
    queryKey: ['project-sessions', projectId],
    queryFn: () => listProjectSessions(projectId),
    enabled,
    ...SHARED,
  });

  // Only the detail + sessions queries gate first paint; the optional surfaces
  // (connectors/team) can 403 for viewers and shouldn't hold the whole widget
  // hostage — they just read as "not done yet".
  const isLoading =
    enabled && (detail.isLoading || secrets.isLoading || sessions.isLoading);

  return useMemo<ProjectSetupState>(() => {
    const base = (path: string) => `/projects/${projectId}/${path}`;

    const requiredEnv = secrets.data?.required ?? [];
    const secretItems = secrets.data?.items ?? [];
    const secretsApply = requiredEnv.length > 0;
    const secretsDone =
      !secretsApply ||
      requiredEnv.every((key) =>
        secretItems.some(
          (item) => item.name === key && (item.configured || item.usable_by_me),
        ),
      );

    const connectorCount = connectors.data?.connectors.length ?? 0;
    const memberCount = access.data?.members.length ?? 0;
    const sessionCount = sessions.data?.length ?? 0;

    const steps: ProjectSetupStep[] = [
      ...(secretsApply
        ? [
            {
              id: 'secrets' as const,
              title: 'Add required secrets',
              description: 'Add the API keys and tokens your project needs.',
              done: secretsDone,
              optional: false,
              icon: KeyRound,
              href: base('secrets'),
              cta: 'Add secrets',
              learnHref: '/docs/concepts/secrets',
            },
          ]
        : []),
      {
        id: 'connector',
        title: 'Connect your tools',
        description: 'Plug in apps your agent should reach — Slack, Gmail, Salesforce, anything.',
        done: connectorCount > 0,
        optional: false,
        icon: Plug,
        href: base('connectors'),
        cta: 'Connect',
        learnHref: '/docs/concepts/connections',
      },
      {
        id: 'team',
        title: 'Invite your team',
        description: 'Add teammates so they can run and review sessions.',
        done: memberCount > 1,
        optional: true,
        icon: Users,
        href: base('members'),
        cta: 'Invite',
        learnHref: '/docs/concepts/accounts',
      },
      {
        id: 'session',
        title: 'Run your first session',
        description: 'Kick off a session to put the project to work.',
        done: sessionCount > 0,
        optional: false,
        icon: SquarePen,
        href: null,
        cta: 'Start',
        learnHref: '/docs/quickstart',
      },
    ];

    const required = steps.filter((s) => !s.optional);
    const requiredDone = required.filter((s) => s.done).length;
    const requiredTotal = required.length;
    const percent = requiredTotal === 0 ? 100 : Math.round((requiredDone / requiredTotal) * 100);

    return {
      steps,
      requiredTotal,
      requiredDone,
      percent,
      isComplete: !isLoading && requiredDone === requiredTotal,
      isLoading,
    };
  }, [
    projectId,
    detail.data,
    secrets.data,
    connectors.data,
    access.data,
    sessions.data,
    isLoading,
  ]);
}

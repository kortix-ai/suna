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
 *
 * Essential steps (drive the headline progress + the auto-hide):
 *   1. Required secrets filled in   (only shown when the manifest declares any)
 *   2. Invite your team
 *   3. Connect at least one integration
 *   4. First session run
 *   5. Create your own agent
 *   6. Create a skill
 *
 * The two "create …" steps complete off the project's agent/skill counts,
 * which ride along on the detail query we already fetch (no sandbox needed —
 * `config.agents`/`config.skills` are parsed from the repo). The catch: every
 * starter ships default agents and skills, so a raw count would read as "done"
 * before the user makes anything of their own. We snapshot the starter's
 * counts once per project (a localStorage BASELINE) and only mark the step
 * done when the live count climbs ABOVE that baseline — i.e. the user added
 * their own. If storage is unavailable we degrade to "not done yet" (the card
 * stays, and is dismissible) rather than falsely ticking.
 */

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Bot,
  KeyRound,
  Plug,
  SquarePen,
  Users,
  Wand2,
  type LucideIcon,
} from 'lucide-react';

import {
  getProjectDetail,
  listConnectors,
  listProjectAccess,
  listProjectSecrets,
  listProjectSessions,
} from '@/lib/projects-client';
import type { CustomizeSection } from '@/lib/customize-sections';

export type ProjectSetupStepId =
  | 'secrets'
  | 'session'
  | 'connector'
  | 'team'
  | 'agent'
  | 'skill';

export interface ProjectSetupStep {
  id: ProjectSetupStepId;
  title: string;
  description: string;
  done: boolean;
  /** Recommended-but-not-required: shown, badged, excluded from completion. */
  optional: boolean;
  icon: LucideIcon;
  /** Customize overlay section that completes this step; null = handled by the
   *  caller (e.g. "session" starts a session rather than opening Customize). */
  section: CustomizeSection | null;
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

/**
 * Per-project snapshot of how many agents/skills the project STARTED with
 * (the starter's defaults). Captured once, the first time we see real config
 * data, and persisted so the baseline survives reloads. The "create your own"
 * steps complete only when the live count climbs above it.
 */
type SetupBaseline = { agents: number; skills: number };

function baselineKey(projectId: string) {
  return `kortix:setup-baseline:${projectId}`;
}

function readBaseline(projectId: string): SetupBaseline | null {
  try {
    const raw = localStorage.getItem(baselineKey(projectId));
    return raw ? (JSON.parse(raw) as SetupBaseline) : null;
  } catch {
    return null; // private mode / SSR
  }
}

function writeBaseline(projectId: string, value: SetupBaseline) {
  try {
    localStorage.setItem(baselineKey(projectId), JSON.stringify(value));
  } catch {
    /* private mode / SSR — degrade to "not done yet" */
  }
}

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

  // Agent/skill counts ride along on the detail query (parsed from the repo —
  // no sandbox needed). We snapshot the starter's counts the first time we see
  // real data so "create your own" completes only when the user adds beyond it.
  const agentCount = detail.data?.config?.agents?.length ?? 0;
  const skillCount = detail.data?.config?.skills?.length ?? 0;
  const [baseline, setBaseline] = useState<SetupBaseline | null>(null);
  useEffect(() => {
    if (!enabled || !detail.data || baseline) return;
    const stored = readBaseline(projectId);
    if (stored) {
      setBaseline(stored);
      return;
    }
    const fresh = { agents: agentCount, skills: skillCount };
    writeBaseline(projectId, fresh);
    setBaseline(fresh);
  }, [enabled, detail.data, projectId, baseline, agentCount, skillCount]);

  return useMemo<ProjectSetupState>(() => {
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
    // Done only once the count climbs above the starter baseline; until the
    // baseline is captured we read "not done yet" rather than falsely ticking.
    const agentDone = baseline ? agentCount > baseline.agents : false;
    const skillDone = baseline ? skillCount > baseline.skills : false;

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
              section: 'secrets' as const,
              cta: 'Add secrets',
              learnHref: '/docs/concepts/secrets',
            },
          ]
        : []),
      {
        id: 'team',
        title: 'Invite your team',
        description: 'Bring teammates in so they can run sessions and review the work.',
        done: memberCount > 1,
        optional: false,
        icon: Users,
        section: 'members' as const,
        cta: 'Invite',
        learnHref: '/docs/concepts/accounts',
      },
      {
        id: 'connector',
        title: 'Connect your tools',
        description: 'Plug in apps your agent should reach — Slack, Gmail, Salesforce, anything.',
        done: connectorCount > 0,
        optional: false,
        icon: Plug,
        section: 'connectors' as const,
        cta: 'Connect',
        learnHref: '/docs/concepts/connections',
      },
      {
        id: 'session',
        title: 'Run your first session',
        description: 'Kick off a session to put the project to work.',
        done: sessionCount > 0,
        optional: false,
        icon: SquarePen,
        section: null,
        cta: 'Start',
        learnHref: '/docs/quickstart',
      },
      {
        id: 'agent',
        title: 'Create your own agent',
        description: 'Shape an agent around how your team works — give it a role and tools.',
        done: agentDone,
        optional: false,
        icon: Bot,
        section: 'agents' as const,
        cta: 'Create',
        learnHref: '/docs/concepts/agents',
      },
      {
        id: 'skill',
        title: 'Add a skill',
        description: 'Turn a workflow you repeat into a reusable shortcut your agents can use.',
        done: skillDone,
        optional: false,
        icon: Wand2,
        section: 'skills' as const,
        cta: 'Add',
        learnHref: '/docs/concepts/agents',
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
    agentCount,
    skillCount,
    baseline,
    isLoading,
  ]);
}

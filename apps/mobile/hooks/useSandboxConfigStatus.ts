/**
 * useSandboxConfigStatus — mobile port of the web SidebarConfigDegradationNotice
 * data flow (apps/web/src/components/sidebar/sidebar-left.tsx).
 *
 * Polls the sandbox's /config/status endpoint (fail-soft diagnostics) and
 * exposes a mutation that creates + starts a Kortix task to repair the
 * skipped config source, mirroring the web "Fix" / "Prompt" behavior.
 */

import { useCallback, useMemo } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useSandboxContext } from '@/contexts/SandboxContext';
import { opencodeFetch } from '@/lib/opencode/hooks/use-opencode-data';

// ─── Types (mirror the web SidebarSandbox* interfaces) ───────────────────────

export interface SandboxConfigProblem {
  source: string;
  scope: 'global' | 'local' | 'env' | 'managed' | 'remote' | string;
  kind: 'json' | 'schema' | 'substitution' | string;
  message?: string;
  issues?: Array<{ message?: string }>;
}

export interface SandboxConfigStatus {
  valid: boolean;
  loadedSources: string[];
  skippedSources: string[];
  problems: SandboxConfigProblem[];
}

export interface SandboxProjectSummary {
  id: string;
  name: string;
  path: string;
}

function isSandboxConfigStatus(value: unknown): value is SandboxConfigStatus {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.valid === 'boolean'
    && Array.isArray(candidate.loadedSources)
    && Array.isArray(candidate.skippedSources)
    && Array.isArray(candidate.problems);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function pickConfigFixProject(projects: SandboxProjectSummary[]): SandboxProjectSummary | null {
  return projects.find((project) => project.path === '/workspace') ?? projects[0] ?? null;
}

export function buildConfigFixPrompt(
  sandboxName: string,
  status: SandboxConfigStatus,
): string {
  const header = `Inspect and repair the ignored OpenCode config sources for instance "${sandboxName}".`;
  const explanation = 'OpenCode is running in fail-soft mode and skipped the invalid sources below instead of crashing the runtime.';
  const problems = status.problems.map((problem, index) => {
    const issueLines = (problem.issues ?? []).map((issue) => issue.message).filter(Boolean) as string[];
    return [
      `${index + 1}. Source: ${problem.source}`,
      `   Scope: ${problem.scope}`,
      `   Kind: ${problem.kind}`,
      `   Message: ${problem.message || 'No message provided.'}`,
      ...(issueLines.length ? issueLines.map((line) => `   Detail: ${line}`) : []),
    ].join('\n');
  }).join('\n\n');

  return [
    header,
    explanation,
    '',
    problems,
    '',
    'Repair the invalid source in place. If the problem is a legacy top-level `models` array, migrate it to valid `provider` config.',
    'When finished, verify `GET /config/status` returns `{"valid": true, "skippedSources": []}` and the runtime stays healthy.',
  ].join('\n');
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useSandboxConfigStatus() {
  const { sandboxUrl, sandboxId, sandboxName } = useSandboxContext();

  const configStatusQuery = useQuery<SandboxConfigStatus>({
    queryKey: ['sandbox-config-status', sandboxId, sandboxUrl],
    enabled: !!sandboxUrl,
    queryFn: async () => {
      const data = await opencodeFetch<unknown>(sandboxUrl!, '/config/status');
      if (!isSandboxConfigStatus(data)) {
        throw new Error('This runtime does not expose config diagnostics yet.');
      }
      return data;
    },
    staleTime: 5_000,
    retry: false,
    refetchInterval: false,
    refetchOnWindowFocus: true,
  });

  const configStatus = configStatusQuery.data;
  const hasProblem = !!configStatus && !configStatus.valid && configStatus.problems.length > 0;

  const projectsQuery = useQuery<SandboxProjectSummary[]>({
    queryKey: ['sandbox-config-projects', sandboxId, sandboxUrl],
    enabled: !!sandboxUrl && hasProblem,
    queryFn: async () => {
      const data = await opencodeFetch<unknown>(sandboxUrl!, '/kortix/projects');
      return Array.isArray(data) ? data as SandboxProjectSummary[] : [];
    },
    staleTime: 30_000,
  });

  const configFixProject = useMemo(
    () => pickConfigFixProject(projectsQuery.data ?? []),
    [projectsQuery.data],
  );

  const configFixPrompt = useMemo(() => {
    if (!configStatus || configStatus.valid) return null;
    return buildConfigFixPrompt(sandboxName || sandboxId || 'sandbox', configStatus);
  }, [configStatus, sandboxName, sandboxId]);

  const startFixTaskMutation = useMutation({
    mutationFn: async () => {
      if (!sandboxUrl || !configStatus || configStatus.valid) {
        throw new Error('No invalid config source is currently being skipped.');
      }
      const targetProject = configFixProject ?? await opencodeFetch<SandboxProjectSummary>(sandboxUrl, '/kortix/projects', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Workspace',
          path: '/workspace',
          description: 'Default workspace project for runtime repair tasks.',
        }),
      });

      const task = await opencodeFetch<{ id: string }>(sandboxUrl, '/kortix/tasks', {
        method: 'POST',
        body: JSON.stringify({
          project_id: targetProject.id,
          title: configStatus.problems.length > 1
            ? 'Fix ignored OpenCode config sources'
            : 'Fix ignored OpenCode config source',
          description: buildConfigFixPrompt(sandboxName || sandboxId || 'sandbox', configStatus),
          verification_condition: 'GET /config/status returns {"valid":true,"skippedSources":[]} for this instance.',
          status: 'todo',
        }),
      });

      await opencodeFetch(sandboxUrl, `/kortix/tasks/${encodeURIComponent(task.id)}/start`, {
        method: 'POST',
      });

      return { taskId: task.id, project: targetProject };
    },
  });

  const startFixTask = useCallback(
    () => startFixTaskMutation.mutateAsync(),
    [startFixTaskMutation],
  );

  return {
    configStatus,
    hasProblem,
    primaryProblem: hasProblem ? configStatus!.problems[0] : null,
    extraProblemsCount: hasProblem ? Math.max(0, configStatus!.problems.length - 1) : 0,
    configFixProject,
    configFixPrompt,
    startFixTask,
    isStartingFix: startFixTaskMutation.isPending,
    fixError: startFixTaskMutation.error as Error | null,
  };
}

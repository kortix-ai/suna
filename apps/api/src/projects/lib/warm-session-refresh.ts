import type { GitBackedProject } from '../git';
import {
  latestAgentConfigEtag,
  readSandboxConfigState,
} from './session-reload';
import { pushSessionAgentConfigToSandbox } from './sandbox-env-sync';
import {
  refreshWarmSessionWorkspace,
  type WarmSessionWorkspaceRefresh,
} from './warm-session-workspace';

export type WarmSessionConfigRefresh =
  | { status: 'current'; previous_etag: string; latest_etag: string }
  | { status: 'updated'; previous_etag: string | null; latest_etag: string }
  | { status: 'unavailable' | 'not-applicable' }
  | { status: 'failed'; reason: string };

interface WarmSessionRefreshDependencies {
  refreshWorkspace: (
    project: GitBackedProject,
    sessionId: string,
  ) => Promise<WarmSessionWorkspaceRefresh>;
  readRunningConfig: (sessionId: string) => Promise<{
    etag: string | null;
    reachable: boolean;
  }>;
  readLatestConfig: (input: {
    projectId: string;
    accountId: string;
    baseRef: string;
  }) => Promise<string | null>;
  pushConfig: (input: {
    projectId: string;
    sessionId: string;
    repoUrl: string;
    defaultBranch: string;
    manifestPath?: string | null;
    baseRef: string;
  }) => Promise<{ applied: boolean; reason?: string }>;
}

const defaultDependencies: WarmSessionRefreshDependencies = {
  refreshWorkspace: refreshWarmSessionWorkspace,
  readRunningConfig: async (sessionId) => readSandboxConfigState({ sessionId }),
  readLatestConfig: latestAgentConfigEtag,
  pushConfig: pushSessionAgentConfigToSandbox,
};

/**
 * Prepare an unused warm session for display and claim.
 *
 * A warm session can sit ready while the project's agent config changes. The
 * workspace refresh already moves its pristine checkout to the latest base.
 * The compiled config lives in the runtime environment, so it needs a separate
 * push. The session is still unclaimed here, which makes this the only safe
 * time to restart its runtime without interrupting user work.
 */
export async function prepareReusedWarmSession(
  input: {
    project: GitBackedProject;
    accountId: string;
    sessionId: string;
  },
  dependencies: WarmSessionRefreshDependencies = defaultDependencies,
): Promise<{
  workspace: WarmSessionWorkspaceRefresh;
  config: WarmSessionConfigRefresh;
}> {
  const workspace = await dependencies.refreshWorkspace(
    input.project,
    input.sessionId,
  );
  const [running, latest] = await Promise.all([
    dependencies.readRunningConfig(input.sessionId),
    dependencies.readLatestConfig({
      projectId: input.project.projectId,
      accountId: input.accountId,
      baseRef: input.project.defaultBranch,
    }),
  ]);

  if (!running.reachable) return { workspace, config: { status: 'unavailable' } };
  if (!latest) return { workspace, config: { status: 'not-applicable' } };
  if (running.etag === latest) {
    return {
      workspace,
      config: {
        status: 'current',
        previous_etag: running.etag,
        latest_etag: latest,
      },
    };
  }

  const pushed = await dependencies.pushConfig({
    projectId: input.project.projectId,
    sessionId: input.sessionId,
    repoUrl: input.project.repoUrl,
    defaultBranch: input.project.defaultBranch,
    manifestPath: input.project.manifestPath,
    baseRef: input.project.defaultBranch,
  });
  if (!pushed.applied) {
    return {
      workspace,
      config: {
        status: 'failed',
        reason: pushed.reason ?? 'config push did not apply',
      },
    };
  }
  return {
    workspace,
    config: {
      status: 'updated',
      previous_etag: running.etag,
      latest_etag: latest,
    },
  };
}
